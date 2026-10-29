import fs from "node:fs";
import path from "node:path";

import { sleep } from "../exness/client.js";
import type { Tools } from "../tools/index.js";
import type { TradeTools } from "../tools/trading.js";
import type { EventHub, TickHub } from "../runtime/hubs.js";
import type { AccountView, SnapshotCache } from "../runtime/snapshot.js";
import { dropFormingCandle, pipSize, type NormalizedCandle } from "../market/candles.js";
import { timeframeMs } from "../market/timeframes.js";
import type { EquityTracker } from "../monitor/equity.js";
import type { AgentConfig } from "./config.js";
import { decideEntry, entryConfigFrom, type EntrySignal } from "./entry.js";
import type { AgentActivity, AgentJournal, AgentRole, AgentTone } from "./journal.js";
import type { Candidate, ScanDiagnostics } from "./screener.js";
import { Screener, screenerOptionsFrom } from "./screener.js";
import type { ExecutorState, RealizedStats, RiskExecutor, TradeLogEntry } from "./risk-and-executor.js";
import { shouldOpenReentry, type EntryTriggerState } from "./reentry.js";
import { lockedProfitDistance } from "./trailing.js";

const SCAN_GRACE_MS = 2_000;

export interface AgentStateFile {
  running: boolean;
  mode: "live" | "dry-run";
  updatedAt: number;
  startedAt: number;
  universe: number;
  nextScanAt: number;
  timeframes: {
    screener: string;
    trend: string;
    confirm: string;
    trail: string;
  };
  screener: {
    at: number;
    durationMs: number;
    pass: number;
    candidates: Array<{
      symbol: string;
      direction: string;
      setupType: string;
      score: number;
      spreadPct: number;
      spreadPips: number;
      rsi: number;
      atrPct: number;
      reasons: string[];
    }>;
    diagnostics?: ScanDiagnostics;
  };
  lastSignal:
    | {
        at: number;
        symbol: string;
        side: string;
        lot: number;
        entry: number;
        sl: number;
        trail: number;
        score: number;
        reasons: string[];
      }
    | null;
  trailing: Array<{ at: number; symbol: string; positionId: string; sl: number }>;
  openPositions: Array<{
    positionId: string;
    symbol: string;
    side: string;
    volume: number;
    entry: number;
    /** broker-side emergency SL */
    sl: number;
    /** program-side virtual trailing stop */
    trail: number;
    best: number;
    trailDistance: number;
    atr: number;
    score: number;
    /** USD profit secured once the virtual trail locked beyond entry. */
    lockedProfitUsd: number;
  }>;
  stats: RealizedStats & { winRate: number };
  dailyPnl: number;
  note?: string;
  /** Per-agent activity feed for the dashboard containers. */
  activity?: AgentActivity[];
  tradeLog: TradeLogEntry[];
  /** Recent successful entry triggers, persisted to avoid duplicate tick-level entries after restarts. */
  entryTriggers?: EntryTriggerState[];
  /** Full executor state (managed positions with SL/trail metadata) for restarts. */
  executor: ExecutorState;
}

export interface EngineDeps {
  config: AgentConfig;
  live: boolean;
  universe: string[];
  cacheDir: string;
  tools: Tools;
  tradeTools: TradeTools;
  ticks: TickHub;
  events: EventHub;
  snapshot: SnapshotCache;
  equity: EquityTracker;
  executor: RiskExecutor;
  journal: AgentJournal;
  log: (line: string) => void;
  stateFile?: string;
}

export class AgentEngine {
  readonly screener: Screener;
  private readonly stateFile: string;
  private readonly journal: AgentJournal;
  private startedAt = 0;
  private running = false;
  private stopped = false;
  private scanning = false;
  private scanRequested = false;
  private managing = false;
  private lastScanAt = 0;
  private lastScanDurationMs = 0;
  private candidates: Candidate[] = [];
  private lastSignal: EntrySignal & { lot?: number } | null = null;
  private note = "";
  private lastView?: AccountView;
  private lastGateLog = "";
  private nextScanAt = 0;
  private feedDownSince = 0;
  private lastFeedWarnAt = 0;
  private lastFeedRestartAt = 0;
  private manageBackoffUntil = 0;
  private lastManageErrorAt = 0;
  private lastScanStatsLogAt = 0;
  private lastEntryRejectLogAt = 0;
  private lastTriggerHoldLogAt = 0;
  private readonly entryTriggers = new Map<string, EntryTriggerState>();
  private readonly entryRetryAt = new Map<string, number>();

  constructor(private readonly deps: EngineDeps) {
    this.screener = new Screener(deps.tools, deps.ticks, screenerOptionsFrom(deps.config));
    this.stateFile = deps.stateFile ?? path.join(deps.cacheDir, "agent-state.json");
    this.journal = deps.journal;
    this.deps.ticks.onQuote = (quote) => {
      this.screener.observe(quote);
      // TS VIRT consumes each live quote directly; broker/account management
      // continues on its separate, rate-limited timer.
      this.deps.executor.onQuote(quote);
    };
  }

  /** Record an activity line for one agent and mirror it to stdout. */
  private record(agent: AgentRole, message: string, tone: AgentTone = "info"): void {
    this.journal.record(agent, message, tone);
    this.deps.log(message);
  }

  /** Restore executor state from the previous run (positions survive restarts). */
  restore(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as AgentStateFile;
      this.deps.executor.restore(raw.executor);
      this.journal.restore(raw.activity);
      if (Array.isArray(raw.entryTriggers)) {
        for (const trigger of raw.entryTriggers.slice(-500)) {
          if (
            trigger &&
            typeof trigger.symbol === "string" &&
            (trigger.side === "buy" || trigger.side === "sell") &&
            typeof trigger.candleTime === "string" &&
            Number.isFinite(trigger.price) &&
            trigger.price > 0 &&
            Number.isFinite(trigger.at)
          ) {
            this.entryTriggers.set(`${trigger.symbol}:${trigger.side}`, trigger);
          }
        }
      } else {
        // Older state files did not persist trigger watermarks. Seed from
        // current managed positions to avoid immediate duplicate entries.
        for (const position of this.deps.executor.managed.values()) {
          const trigger: EntryTriggerState = {
            symbol: position.symbol,
            side: position.side,
            candleTime: "",
            price: position.entry,
            at: position.openedAt,
          };
          const key = `${trigger.symbol}:${trigger.side}`;
          const previous = this.entryTriggers.get(key);
          if (!previous || previous.at < trigger.at) this.entryTriggers.set(key, trigger);
        }
      }
    } catch {
      // first run
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.startedAt = Date.now();
    this.restore();

    this.record(
      "screener",
      `agent ${this.deps.live ? "LIVE" : "DRY-RUN"} · ${this.deps.universe.length} pairs · ` +
        `scan ${this.deps.config.alignScanToCandle ? "candle-aligned" : `${this.deps.config.scanIntervalMs}ms`} · ` +
        `screener ${this.deps.config.screenerTimeframe} · trend ${this.deps.config.trendTimeframe} · ` +
        `confirm ${this.deps.config.confirmTimeframe} · trail ${this.deps.config.trailTimeframe} · ` +
        `risk ${this.deps.config.riskPct}% of live account equity · ` +
        `spread cap ${this.deps.config.maxSpreadPips}p / ${this.deps.config.maxSpreadPct}% · spike guard ${this.deps.config.maxSpreadSpikeRatio}× · ` +
        `aggregate open-risk cap ${this.deps.config.maxOpenRiskPct}% · ` +
        `emergency ${this.deps.config.emergencySlAtrFactor}×M1 ATR · ` +
        `trail ${this.deps.config.trailAtrFactor}×ATR (min ${this.deps.config.trailMinPips}p)`,
    );
    this.writeState();
    this.deps.events.start();
    this.deps.ticks.start(this.deps.universe);
    for (let i = 0; i < 15 && this.deps.events.state !== "open"; i += 1) {
      if (this.stopped) return;
      await sleep(100);
    }
    // Use a bounded, smaller warm-up. Waiting for 120 quotes could delay the
    // first scan by 40 seconds even though enough live prices are already available.
    const warmTarget = Math.min(this.deps.universe.length, 24);
    for (let i = 0; i < 40 && this.deps.ticks.quotesCount < warmTarget; i += 1) {
      if (this.stopped) return;
      await sleep(125);
    }
    if (this.stopped) return;
    this.record(
      "screener",
      `feed warm ${this.deps.ticks.quotesCount}/${this.deps.universe.length} quotes · starting scan`,
    );

    this.writeState();
    this.schedule();
    await this.scanAndEnter();
  }

  schedule(): void {
    const manage = setInterval(() => {
      void this.manageTick();
    }, this.deps.config.manageIntervalMs);
    manage.unref();
    this.loopTimers = [manage];
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.stopped) return;
    const now = Date.now();
    const interval = timeframeMs(this.deps.config.screenerTimeframe);
    const delay = this.deps.config.alignScanToCandle
      ? interval - (now % interval) + SCAN_GRACE_MS
      : Math.max(1_000, this.deps.config.scanIntervalMs);
    this.nextScanAt = now + delay;
    const timer = setTimeout(() => {
      void this.scanAndEnter().finally(() => this.scheduleScan());
    }, delay);
    timer.unref();
    this.loopTimers.push(timer);
  }

  private loopTimers: NodeJS.Timeout[] = [];

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.nextScanAt = 0;
    for (const timer of this.loopTimers) clearInterval(timer);
    this.loopTimers = [];
    this.journal.record("screener", "agent stopped · state saved", "warn");
    this.writeState();
  }

  private async manageTick(): Promise<void> {
    if (this.managing || this.stopped) return;
    if (Date.now() < this.manageBackoffUntil) return;
    this.managing = true;
    try {
      this.watchdog();
      const view = await this.deps.snapshot.get();
      this.deps.equity.record(view);
      await this.deps.executor.manage(view);
      // Write after every manage tick so a trail advance or close is not lost
      // if the process dies before the next 5s state throttle.
      this.writeState(view);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = /REQUEST_RATE_LIMIT|rate.?limit/i.test(message);
      if (rateLimited) {
        // Multiple terminals/scans share the broker's account-wide bucket.
        // Back off instead of retrying every second and making it worse.
        this.manageBackoffUntil = Date.now() + 15_000;
      }
      const now = Date.now();
      if (now - this.lastManageErrorAt > (rateLimited ? 30_000 : 5_000)) {
        this.lastManageErrorAt = now;
        this.record("trader", `manage error: ${message}`, "error");
      }
    } finally {
      this.managing = false;
    }
  }

  /**
   * Watchdog: the WS layer reconnects with backoff, but a wedged connection
   * needs a nudge. Alarm once, then force a fresh socket after 45 seconds.
   */
  private watchdog(): void {
    const now = Date.now();
    const state = this.deps.ticks.state;
    if (state === "open") {
      this.feedDownSince = 0;
      const lastTick = this.deps.ticks.lastTickAt;
      if (lastTick > 0 && now - lastTick > 60_000 && now - this.lastFeedWarnAt > 60_000) {
        this.lastFeedWarnAt = now;
        this.record(
          "trader",
          `watchdog: no ticks for ${Math.round((now - lastTick) / 1000)}s · ${this.deps.ticks.quotesCount} quotes cached`,
          "warn",
        );
      }
      return;
    }

    if (this.feedDownSince === 0) this.feedDownSince = now;
    const downMs = now - this.feedDownSince;
    if (downMs > 5_000 && now - this.lastFeedWarnAt > 30_000) {
      this.lastFeedWarnAt = now;
      this.record("trader", `watchdog: tick feed ${state} for ${Math.round(downMs / 1000)}s`, "warn");
    }
    if (downMs > 45_000 && now - this.lastFeedRestartAt > 60_000) {
      this.lastFeedRestartAt = now;
      this.feedDownSince = now;
      this.record("trader", "watchdog: restarting tick websocket", "error");
      this.deps.ticks.restart();
    }
  }

  async scanAndEnter(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) {
      this.scanRequested = true;
      return;
    }
    this.scanning = true;
    const started = Date.now();
    try {
      const candidates = await this.screener.scan(this.deps.universe);
      if (this.stopped) return;
      this.candidates = candidates;
      this.lastScanAt = started;
      this.lastScanDurationMs = this.screener.lastScanDurationMs;

      let view = await this.deps.snapshot.get();
      const gate = this.deps.executor.tradingAllowed(view);
      this.note = gate.ok ? "" : gate.reason ?? "";

      const diagnostics = this.screener.lastDiagnostics;
      // Keep the 2-second scan loop observable without flooding the dashboard
      // journal with repetitive lines; order events are still logged immediately.
      if (Date.now() - this.lastScanStatsLogAt >= 5_000) {
        this.lastScanStatsLogAt = Date.now();
        this.record(
          "screener",
          `fresh ${diagnostics.fresh}/${diagnostics.withQuote} · prefilter ${diagnostics.prefiltered} · ` +
            `shortlist ${diagnostics.shortlist} · cache pending ${diagnostics.cachePending} · cache errors ${diagnostics.cacheFailures} · ` +
            `spread reject ${diagnostics.spreadRejected} (${diagnostics.spreadSpikeRejected} spikes) · pass ${diagnostics.passed}`,
        );
        const rejectionSummary = Object.entries(diagnostics.scoreRejects)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([reason, count]) => `${reason} ${count}`)
          .join(" · ");
        if (rejectionSummary) {
          this.record("screener", `screen rejects ${rejectionSummary}`, "warn");
        }
        if (diagnostics.top.length > 0) {
          this.record(
            "screener",
            `top ${diagnostics.top
              .slice(0, 4)
              .map((entry) => `${entry.symbol} ${entry.prelim}`)
              .join(" · ")}`,
          );
        }
        this.record(
          "screener",
          `scan ${((Date.now() - started) / 1000).toFixed(1)}s · ${candidates.length} kandidat` +
            (candidates[0]
              ? ` · ${candidates[0].symbol} ${candidates[0].direction} ${candidates[0].setupType} ${candidates[0].score.toFixed(0)}`
              : "") +
            (gate.ok ? "" : ` · ${gate.reason}`),
          gate.ok ? "success" : "warn",
        );
      }

      if (!gate.ok) {
        this.writeState(view);
        return;
      }

      // Adopt any open broker position before the entry gate runs, so a
      // position opened outside the bot no longer blocks new entries.
      await this.deps.executor.syncPositions(view);

      // Every pair the screener passes is a candidate. Entry needs only the
      // last closed confirmation candle; there is no M5 step and no TP.
      const tried: string[] = [];
      const entered: string[] = [];
      let triggerSuppressed = 0;
      for (const candidate of candidates) {
        if (this.stopped) return;
        const quote = this.deps.ticks.get(candidate.symbol);
        if (!quote) {
          tried.push(`${candidate.symbol}: no live quote`);
          continue;
        }

        const confirmation = await this.confirmationFor(candidate);
        if (!confirmation.ok) {
          tried.push(`${candidate.symbol}: ${confirmation.reason}`);
          continue;
        }

        const decision = decideEntry({
          candidate,
          quote,
          config: entryConfigFrom(this.deps.config),
          confirmCandles: confirmation.candles,
        });
        if (!decision.signal) {
          tried.push(`${candidate.symbol}: ${decision.rejects.join("; ") || "no signal"}`);
          continue;
        }

        const triggerKey = `${candidate.symbol}:${decision.signal.side}`;
        const candleTime = candidate.candles[candidate.candles.length - 1]?.time ?? "";
        const triggerPrice = decision.signal.entry;
        const previousTrigger = this.entryTriggers.get(triggerKey);
        const reentryAllowed = shouldOpenReentry({
          side: decision.signal.side,
          candleTime,
          price: triggerPrice,
          atr: decision.signal.atr,
          stepAtr: this.deps.config.reentryStepAtr,
          minimumStep: this.deps.config.reentryMinPips * decision.signal.pip,
          previous: previousTrigger,
        });
        if (!reentryAllowed || (this.entryRetryAt.get(triggerKey) ?? 0) > Date.now()) {
          triggerSuppressed += 1;
          continue;
        }

        this.lastSignal = decision.signal;
        this.record(
          "entry",
          `sinyal ${decision.signal.side.toUpperCase()} ${candidate.symbol} [${candidate.setupType}] ` +
            `entry ${decision.signal.entry} emergency SL ${decision.signal.emergencySl} ` +
            `trail ${decision.signal.trailDistance.toFixed(5)} ` +
            `(${decision.signal.slPips.toFixed(1)}p)`,
          "success",
        );

        if (!this.deps.live) {
          this.entryTriggers.set(triggerKey, {
            symbol: candidate.symbol,
            side: decision.signal.side,
            candleTime,
            price: triggerPrice,
            at: Date.now(),
          });
          entered.push(`${candidate.symbol} (dry)`);
          continue;
        }

        // Refresh the snapshot so margin and aggregate-risk checks include
        // positions opened earlier in this same scan.
        view = await this.deps.snapshot.get();
        const opened = await this.deps.executor.open(decision.signal, view);
        if (opened.ok && opened.managed) {
          this.lastSignal = {
            ...decision.signal,
            entry: opened.managed.entry,
            emergencySl: opened.managed.emergencySl,
            slPips: Math.abs(opened.managed.entry - opened.managed.emergencySl) / opened.managed.pip,
            lot: opened.managed.volume,
          };
          this.entryTriggers.set(triggerKey, {
            symbol: opened.managed.symbol,
            side: decision.signal.side,
            candleTime,
            price: opened.managed.entry,
            at: opened.managed.openedAt,
          });
          this.entryRetryAt.delete(triggerKey);
          entered.push(`${opened.managed.symbol} ${opened.managed.volume} lot`);
          this.record(
            "entry",
            `open ${opened.managed.symbol} ${opened.managed.volume} lot ` +
              `@ ${opened.managed.entry} emergency SL ${opened.managed.emergencySl} ` +
              `virtual ${opened.managed.trailStop}`,
            "success",
          );
          continue;
        }
        this.entryRetryAt.set(triggerKey, Date.now() + 3_000);
        const openReason = opened.reason ?? "rejected";
        this.record(
          "entry",
          `open ditolak ${candidate.symbol}: ${openReason}`,
          "warn",
        );
        tried.push(`${candidate.symbol}: ${openReason}`);
        // These are account-wide gates; retrying every remaining candidate in
        // the same scan only wastes snapshot/order-rate budget.
        if (/kill switch|daily loss limit|unmanaged position present|open position risk metadata unavailable|open risk cap|trade_mode|status inactive|no USD conversion for account currency/i.test(openReason)) {
          this.record("entry", `remaining candidates paused by account gate: ${openReason}`, "warn");
          break;
        }
      }

      if (triggerSuppressed > 0 && Date.now() - this.lastTriggerHoldLogAt >= 10_000) {
        this.lastTriggerHoldLogAt = Date.now();
        this.record(
          "entry",
          `${triggerSuppressed} signal(s) held: waiting for a new closed candle or favourable re-entry step`,
        );
      }
      if (entered.length > 0) {
        this.note = this.deps.live
          ? `opened ${entered.length}: ${entered.join(" · ")}`
          : `dry-run signals: ${entered.join(" · ")}`;
      } else if (tried.length > 0) {
        this.note = tried[0] ?? "";
        if (Date.now() - this.lastEntryRejectLogAt >= 5_000) {
          this.lastEntryRejectLogAt = Date.now();
          this.record("entry", `entry ${tried.join(" · ")}`, "warn");
        }
      }
      this.writeState(view);
    } catch (error) {
      this.record(
        "screener",
        `scan error: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      this.scanning = false;
      if (this.scanRequested && !this.stopped) {
        this.scanRequested = false;
        queueMicrotask(() => void this.scanAndEnter());
      }
    }
  }

  private async confirmationFor(
    candidate: Candidate,
  ): Promise<{ ok: true; candles?: NormalizedCandle[] } | { ok: false; reason: string }> {
    if (this.deps.config.confirmTimeframe === this.deps.config.screenerTimeframe) {
      return { ok: true };
    }
    const result = await this.deps.tools.get_candles({
      symbol: candidate.symbol,
      timeframe: this.deps.config.confirmTimeframe,
      n: 120,
    });
    if (!result.ok) {
      return { ok: false, reason: `confirm candles: ${result.message}` };
    }
    const candles = dropFormingCandle(
      result.data,
      timeframeMs(this.deps.config.confirmTimeframe),
    );
    if (candles.length < 2) {
      return { ok: false, reason: `confirm candles not ready` };
    }
    return { ok: true, candles };
  }

  state(view?: AccountView): AgentStateFile {
    const stats = this.deps.executor.stats;
    const decided = stats.wins + stats.losses;
    const lastSignal = this.lastSignal;
    const trailing = this.deps.executor.statePayload().trailing;
    // stop() writes the final state without a fresh snapshot. Reuse the last
    // one so the dashboard does not show daily P/L resetting to zero.
    const lastView = view ?? this.lastView;

    return {
      running: this.running,
      mode: this.deps.live ? "live" : "dry-run",
      updatedAt: Date.now(),
      startedAt: this.startedAt,
      universe: this.deps.universe.length,
      nextScanAt: this.nextScanAt,
      timeframes: {
        screener: this.deps.config.screenerTimeframe,
        trend: this.deps.config.trendTimeframe,
        confirm: this.deps.config.confirmTimeframe,
        trail: this.deps.config.trailTimeframe,
      },
      screener: {
        at: this.lastScanAt,
        durationMs: this.lastScanDurationMs,
        pass: this.candidates.length,
        candidates: this.candidates.map((candidate) => ({
          symbol: candidate.symbol,
          direction: candidate.direction,
          setupType: candidate.setupType,
          score: Number(candidate.score.toFixed(1)),
          spreadPct: Number(candidate.spreadPct.toFixed(4)),
          spreadPips: Number(candidate.spreadPips.toFixed(2)),
          rsi: Number(candidate.rsi.toFixed(1)),
          atrPct: Number(candidate.atrPct.toFixed(3)),
          reasons: candidate.reasons,
        })),
        diagnostics: this.screener.lastDiagnostics,
      },
      lastSignal: lastSignal
        ? {
            at: lastSignal.createdAt,
            symbol: lastSignal.symbol,
            side: lastSignal.side,
            lot: lastSignal.lot ?? 0,
            entry: lastSignal.entry,
            sl: lastSignal.emergencySl,
            trail: lastSignal.trailDistance,
            score: lastSignal.score,
            reasons: lastSignal.reasons,
          }
        : null,
      trailing: trailing.slice(-8),
      openPositions: [...this.deps.executor.managed.values()].map((position) => {
        // Only a stop beyond entry has secured anything. A stop still on the
        // loss side must report 0, never a positive "locked" amount.
        const lockedDistance = lockedProfitDistance(position.side, position.trailStop, position.entry);
        const lockedProfitUsd = position.pipValueUsdPerLot && lockedDistance > 0
          ? (lockedDistance / position.pip) * position.volume * position.pipValueUsdPerLot
          : 0;
        return {
          positionId: position.positionId,
          symbol: position.symbol,
          side: position.side,
          volume: position.volume,
          entry: position.entry,
          sl: position.emergencySl,
          trail: position.trailStop,
          best: position.best,
          trailDistance: position.trailDistance,
          atr: position.atr,
          score: position.score,
          lockedProfitUsd: Number(lockedProfitUsd.toFixed(2)),
        };
      }),
      stats: {
        ...stats,
        winRate: decided > 0 ? (stats.wins / decided) * 100 : 0,
      },
      dailyPnl: lastView ? lastView.equity - this.deps.equity.startBalance : 0,
      note: this.note,
      activity: this.journal.recent(80),
      tradeLog: this.deps.executor.statePayload().tradeLog,
      entryTriggers: [...this.entryTriggers.values()].slice(-500),
      executor: this.deps.executor.statePayload(),
    };
  }

  writeState(view?: AccountView): void {
    if (view) this.lastView = view;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, `${JSON.stringify(this.state(view), null, 2)}\n`);
    } catch {
      // monitoring is best effort
    }
  }
}
