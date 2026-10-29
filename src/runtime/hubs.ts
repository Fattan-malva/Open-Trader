import fs from "node:fs";
import path from "node:path";

import { sleep } from "../exness/client.js";
import type { SigningIdentity } from "../exness/signing.js";
import { ExnessSocket, type SocketState } from "../exness/ws.js";
import { QuoteStore, type Quote } from "../market/store.js";

export interface HubOptions {
  accessPoint: string;
  identity: SigningIdentity;
  accountId: string;
  cacheDir?: string;
  verbose?: boolean;
  logger?: (line: string) => void;
}

/**
 * Tick subscriptions are budgeted per instrument: 25/s, no batch burst. Sending
 * one instrument per message also isolates bad symbols (MARKET_INSTRUMENT_NOT_FOUND)
 * so one delisted ticker cannot knock out a whole batch.
 */
const SUBSCRIBE_PER_SECOND = 20;
const SUBSCRIBE_TOKENS = 20;
const SUBSCRIBE_PUMP_MS = 50;

// --------------------------------------------------------------------- ticks

export class TickHub {
  readonly store = new QuoteStore();
  state: SocketState = "closed";
  onQuote?: (quote: Quote) => void;
  lastAckError?: string;

  private socket?: ExnessSocket;
  private readonly symbols = new Set<string>();
  private sequence = 0;
  private window = 0;
  private rate = 0;
  private rateTimer?: NodeJS.Timeout;
  private readonly queued: string[] = [];
  private readonly sent = new Set<string>();
  /**
   * Symbols the broker permanently rejected. Kept across reconnects (and on
   * disk) because one MARKET_INSTRUMENT_NOT_FOUND closes the whole socket; if
   * the symbol were retried, the feed would reconnect forever.
   */
  private readonly failed = new Set<string>();
  private readonly retryCounts = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly failuresFile?: string;
  private readonly pending = new Map<string, { symbol: string; at: number }>();
  private pumpTimer?: NodeJS.Timeout;
  private tokens = SUBSCRIBE_TOKENS;
  private lastRefill = Date.now();

  constructor(private readonly options: HubOptions) {
    this.failuresFile = options.cacheDir
      ? path.join(options.cacheDir, "tick-unsupported.json")
      : undefined;
    this.loadFailures();
  }

  get ticksPerSecond(): number {
    return this.rate;
  }

  get subscribed(): string[] {
    return [...this.sent];
  }

  get quotesCount(): number {
    return this.store.size;
  }

  get lastTickAt(): number {
    return this.store.lastTick;
  }

  start(symbols: string[]): void {
    const added = symbols
      .map((symbol) => symbol.toUpperCase())
      .filter((symbol) => symbol && !this.failed.has(symbol));
    for (const symbol of added) this.symbols.add(symbol);

    if (this.socket) {
      if (this.state === "open" && added.length > 0) this.sendSubscriptions(added);
      return;
    }

    this.socket = new ExnessSocket({
      accessPoint: this.options.accessPoint,
      identity: this.options.identity,
      path: `/v1/server-events/accounts/${this.options.accountId}/ws/ticks`,
      autoReconnect: true,
      logger: this.options.verbose ? this.options.logger : undefined,
      onState: (state) => {
        this.state = state;
        if (state !== "open") {
          // A reconnect starts a new subscription budget; resubscribe in full.
          // Permanent failures stay failed so a bad symbol cannot loop the feed.
          this.sent.clear();
          this.queued.length = 0;
          this.pending.clear();
          this.tokens = SUBSCRIBE_TOKENS;
          this.lastRefill = Date.now();
          if (this.pumpTimer) clearTimeout(this.pumpTimer);
          this.pumpTimer = undefined;
        }
      },
      onOpen: () => {
        this.tokens = SUBSCRIBE_TOKENS;
        this.lastRefill = Date.now();
        this.sendSubscriptions([...this.symbols]);
      },
      onMessage: (message) => this.handleMessage(message),
    });
    this.socket.connect();

    this.rateTimer = setInterval(() => {
      this.rate = this.window;
      this.window = 0;
    }, 1000);
    this.rateTimer.unref();
  }

  subscribe(symbols: string[]): void {
    const added = symbols
      .map((symbol) => symbol.toUpperCase())
      .filter((symbol) => symbol && !this.symbols.has(symbol) && !this.failed.has(symbol));
    for (const symbol of added) this.symbols.add(symbol);
    if (added.length > 0 && this.state === "open") this.sendSubscriptions(added);
  }

  /** Subscribes on demand and waits until every symbol has at least one tick. */
  async ensure(symbols: string[], timeoutMs = 4000): Promise<Quote[]> {
    const wanted = [...new Set(symbols.map((symbol) => symbol.toUpperCase()).filter(Boolean))];
    const missing = wanted.filter((symbol) => !this.store.get(symbol));
    if (missing.length > 0) this.subscribe(missing);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = wanted.map((symbol) => this.store.get(symbol));
      if (found.every(Boolean)) return found as Quote[];
      await sleep(50);
    }
    return wanted
      .map((symbol) => this.store.get(symbol))
      .filter((quote): quote is Quote => quote !== undefined);
  }

  get(symbol: string): Quote | undefined {
    return this.store.get(symbol);
  }

  close(): void {
    if (this.rateTimer) clearInterval(this.rateTimer);
    this.rateTimer = undefined;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.queued.length = 0;
    this.sent.clear();
    this.pending.clear();
    this.socket?.close();
    this.socket = undefined;
    this.state = "closed";
  }

  /** Watchdog escape hatch: drop a wedged socket and resubscribe from scratch. */
  restart(): void {
    const symbols = [...this.symbols];
    this.close();
    if (symbols.length > 0) this.start(symbols);
  }

  private loadFailures(): void {
    if (!this.failuresFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.failuresFile, "utf8")) as unknown;
      // The legacy array also recorded transient subscription failures as
      // permanently unsupported. Ignore it once so every symbol gets retried;
      // only the versioned list below is now persisted from explicit not-found errors.
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const saved = raw as { version?: unknown; symbols?: unknown };
      if (saved.version !== 2 || !Array.isArray(saved.symbols)) return;
      for (const symbol of saved.symbols) {
        if (typeof symbol === "string" && symbol) this.failed.add(symbol.toUpperCase());
      }
    } catch {
      // First run, or a partial file: start with no known failures.
    }
  }

  /** Remember only a broker-confirmed unsupported symbol permanently. */
  private markFailed(symbol: string): void {
    if (this.failed.has(symbol)) return;
    this.failed.add(symbol);
    const timer = this.retryTimers.get(symbol);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(symbol);
    this.retryCounts.delete(symbol);
    this.persistFailures();
  }

  /** Retry transient subscription failures with bounded exponential backoff. */
  private scheduleSubscriptionRetry(symbol: string, baseDelayMs = 1_500): void {
    if (this.failed.has(symbol) || this.retryTimers.has(symbol)) return;
    const attempts = (this.retryCounts.get(symbol) ?? 0) + 1;
    this.retryCounts.set(symbol, attempts);
    const delay = Math.min(60_000, baseDelayMs * (2 ** Math.min(attempts - 1, 6)));
    const timer = setTimeout(() => {
      this.retryTimers.delete(symbol);
      if (!this.failed.has(symbol) && this.symbols.has(symbol) && !this.sent.has(symbol) && !this.queued.includes(symbol)) {
        this.queued.push(symbol);
      }
      this.pumpSubscriptions();
    }, delay);
    timer.unref();
    this.retryTimers.set(symbol, timer);
  }

  private persistFailures(): void {
    if (!this.failuresFile) return;
    try {
      fs.mkdirSync(path.dirname(this.failuresFile), { recursive: true });
      fs.writeFileSync(this.failuresFile, `${JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), symbols: [...this.failed].sort() }, null, 2)}\n`);
    } catch {
      // Best effort: a full disk must not stop the feed.
    }
  }

  private sendSubscriptions(symbols: string[]): void {
    for (const symbol of symbols) {
      if (this.sent.has(symbol) || this.failed.has(symbol) || this.queued.includes(symbol)) continue;
      this.queued.push(symbol);
    }
    this.pumpSubscriptions();
  }

  /** Token bucket: one instrument per message, about 20 subscriptions/s. */
  private pumpSubscriptions(): void {
    if (this.state !== "open") return;
    if (this.pumpTimer) return;

    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.at > 10_000) {
        this.pending.delete(id);
        if (!this.sent.has(entry.symbol) && !this.failed.has(entry.symbol)) {
          this.queued.push(entry.symbol);
        }
      }
    }
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(
        SUBSCRIBE_TOKENS,
        this.tokens + (elapsed / 1000) * SUBSCRIBE_PER_SECOND,
      );
      this.lastRefill = now;
    }

    while (this.tokens >= 1 && this.queued.length > 0) {
      const symbol = this.queued.shift()!;
      if (this.sent.has(symbol) || this.failed.has(symbol)) continue;
      this.tokens -= 1;
      const id = `ticks-${this.sequence += 1}`;
      this.pending.set(id, { symbol, at: Date.now() });
      const ok = this.socket?.send({
        id,
        subscribe: { event: "ticks", instruments: [symbol] },
      });
      if (!ok) {
        this.pending.delete(id);
        this.queued.unshift(symbol);
        break;
      }
    }

    if (this.queued.length > 0) {
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = undefined;
        this.pumpSubscriptions();
      }, SUBSCRIBE_PUMP_MS);
      this.pumpTimer.unref();
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const candidate = message as {
      id?: string;
      code?: number;
      error_message?: string;
      instrument?: string;
      bid?: number;
      ask?: number;
      timestamp?: string;
    };

    if (
      (typeof candidate.code === "number" || typeof candidate.code === "string") &&
      candidate.instrument === undefined
    ) {
      const code = Number(candidate.code);
      const entry = candidate.id ? this.pending.get(candidate.id) : undefined;
      if (candidate.id && entry) {
        this.pending.delete(candidate.id);
        if (code === 200) {
          this.sent.add(entry.symbol);
          this.retryCounts.delete(entry.symbol);
          const retryTimer = this.retryTimers.get(entry.symbol);
          if (retryTimer) clearTimeout(retryTimer);
          this.retryTimers.delete(entry.symbol);
        } else {
          const detail = candidate.error_message ?? "";
          const permanentlyMissing = code === 4000 || /MARKET_INSTRUMENT_NOT_FOUND|instrument.{0,20}(not found|unsupported)|unknown instrument/i.test(detail);
          if (permanentlyMissing) {
            this.markFailed(entry.symbol);
          } else {
            // Rate limiting and other API/socket hiccups are transient; never
            // blacklist a tradable symbol based on an ambiguous error.
            this.scheduleSubscriptionRetry(entry.symbol, code === 3015 ? 3_000 : 1_500);
          }
          this.options.logger?.(
            `subscription failed for ${entry.symbol}: ${code} ${detail}${permanentlyMissing ? " (permanently unsupported)" : " (will retry)"}`,
          );
        }
      }
      if (code !== 200) {
        this.lastAckError = `${code} ${candidate.error_message ?? ""}${
          entry ? ` (${entry.symbol})` : ""
        }`.trim();
        this.options.logger?.(
          `subscription rejected: ${this.lastAckError}${candidate.id ? ` (${candidate.id})` : ""}`,
        );
      }
      this.pumpSubscriptions();
      return;
    }

    if (
      typeof candidate.instrument !== "string" ||
      typeof candidate.bid !== "number" ||
      typeof candidate.ask !== "number"
    ) {
      return;
    }

    const quote = this.store.upsert({
      instrument: candidate.instrument,
      bid: candidate.bid,
      ask: candidate.ask,
      timestamp: candidate.timestamp ?? new Date().toISOString(),
    });
    this.window += 1;
    this.onQuote?.(quote);
  }
}

// -------------------------------------------------------------------- events

export type EventTone = "info" | "success" | "warn" | "error";

export interface RuntimeEvent {
  at: number;
  type: string;
  summary: string;
  tone: EventTone;
  raw: unknown;
}

function eventTime(raw: Record<string, unknown>): number {
  const value = raw.event_time;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export function summarizeEvent(raw: unknown): RuntimeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;

  // Subscription acknowledgements: { id, code, error_message? }
  const rawCode = event.code;
  if ((typeof rawCode === "number" || typeof rawCode === "string") && event.event_type === undefined) {
    const code = Number(rawCode);
    if (code === 200) return null;
    return {
      at: Date.now(),
      type: "subscription",
      summary: `${String(event.id ?? "subscription")} rejected: ${String(code)} ${String(event.error_message ?? "")}`.trim(),
      tone: "error",
      raw,
    };
  }

  const type = typeof event.event_type === "string" ? event.event_type : "event";
  const at = eventTime(event);

  switch (type) {
    case "account_state_event": {
      const state = (event.payload as { account_state?: Record<string, string> } | undefined)
        ?.account_state;
      return {
        at,
        type,
        summary: `equity ${state?.equity ?? "?"} · balance ${state?.balance ?? "?"} · margin ${state?.used_margin ?? "?"}`,
        tone: "info",
        raw,
      };
    }
    case "trading_state_snapshot": {
      const payload = event.payload as
        | { positions?: unknown[]; orders?: unknown[]; account_state?: Record<string, string> }
        | undefined;
      return {
        at,
        type,
        summary: `${payload?.positions?.length ?? 0} positions · ${payload?.orders?.length ?? 0} orders · equity ${payload?.account_state?.equity ?? "?"}`,
        tone: "info",
        raw,
      };
    }
    case "transaction_event": {
      const status = typeof event.status === "string" ? event.status : "?";
      const okStatus = ["confirmed", "filled", "success"].includes(status);
      const failed = ["rejected", "failed"].includes(status);
      const detail = failed
        ? ` ${String(event.error_code ?? "")} ${String(event.error_message ?? "")}`.trimEnd()
        : "";
      return {
        at,
        type,
        summary: `${status} · op ${String(event.operation_id ?? "?")}${detail}`,
        tone: okStatus ? "success" : failed ? "error" : "warn",
        raw,
      };
    }
    case "instrument_event": {
      const instrument = typeof event.instrument === "string" ? event.instrument : "?";
      const action = typeof event.action === "string" ? event.action : "";
      return { at, type, summary: `${instrument} ${action}`.trim(), tone: "info", raw };
    }
    case "hmr_snapshot":
    case "hmr_update":
      return { at, type, summary: "instrument metadata refresh", tone: "warn", raw };
    default:
      return { at, type, summary: "", tone: "info", raw };
  }
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function eventLogPath(cacheDir: string, date = new Date()): string {
  return path.join(cacheDir, "events", `${localDateKey(date)}.jsonl`);
}

export class EventHub {
  readonly events: RuntimeEvent[] = [];
  state: SocketState = "closed";
  onEvent?: (event: RuntimeEvent) => void;

  private socket?: ExnessSocket;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(private readonly options: HubOptions & { instruments?: boolean }) {}

  /** Multiple consumers (dashboard, execution gateway) can listen at once. */
  on(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.socket) return;

    this.socket = new ExnessSocket({
      accessPoint: this.options.accessPoint,
      identity: this.options.identity,
      path: `/v1/server-events/accounts/${this.options.accountId}/ws/events`,
      autoReconnect: true,
      logger: this.options.verbose ? this.options.logger : undefined,
      onState: (state) => {
        this.state = state;
      },
      onOpen: () => {
        this.socket?.send({ id: "events-transactions", subscribe: { event: "transactions" } });
        this.socket?.send({ id: "events-account", subscribe: { event: "account_state" } });
        if (this.options.instruments) {
          this.socket?.send({
            id: "events-instruments",
            subscribe: { event: "instruments", instruments: ["all"] },
          });
        }
      },
      onMessage: (message) => this.handleMessage(message),
    });
    this.socket.connect();
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.state = "closed";
  }

  private handleMessage(message: unknown): void {
    const event = summarizeEvent(message);
    if (!event) return;

    this.events.push(event);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    this.persist(event);
    this.onEvent?.(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A consumer must not break the event stream for others.
      }
    }
  }

  private persist(event: RuntimeEvent): void {
    if (!this.options.cacheDir) return;
    try {
      const file = eventLogPath(this.options.cacheDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
    } catch {
      // Best effort: monitoring must never break because a log write failed.
    }
  }
}
