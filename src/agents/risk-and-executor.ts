import fs from "node:fs";
import path from "node:path";

import type { ExnessClient } from "../exness/client.js";
import { digitsFor } from "../exness/catalog.js";
import type { DealsHistoryResponse, Deal, Position, TransactionEvent } from "../exness/types.js";
import { atr, lastFinite } from "../market/indicators.js";
import { dropFormingCandle, pipSize, type NormalizedCandle } from "../market/candles.js";
import type { Quote } from "../market/store.js";
import { timeframeMs, type Timeframe } from "../market/timeframes.js";
import type { EquityTracker } from "../monitor/equity.js";
import type { EventHub, TickHub } from "../runtime/hubs.js";
import type { OperationResult } from "../runtime/execution.js";
import type { AccountView } from "../runtime/snapshot.js";
import type { Tools } from "../tools/index.js";
import { roundVolumeDown, type TradeTools } from "../tools/trading.js";
import type { AgentConfig } from "./config.js";
import type { EntrySignal } from "./entry.js";
import type { AgentJournal, AgentTone } from "./journal.js";
import { spreadWithinLimit } from "./spread.js";
import {
  advanceVirtualStop,
  canMoveTrailStop,
  initialVirtualStop,
  isFreshQuote,
  profitLockCushion,
  profitLockStop,
  profitTrailDistanceFromAtr,
  trailDistanceFromAtr,
  updateBest,
  virtualStopHit,
  virtualStopLocksProfit,
  type PositionSide,
} from "./trailing.js";

const TS_CLOSE_BUSY_RETRY_MS = 100;
const TS_CLOSE_RETRY_BASE_MS = 250;
const TS_CLOSE_RETRY_MAX_MS = 5_000;

/** Faster retries for a moving quote, with bounded backoff for persistent errors. */
export function closeRetryDelayMs(attempt: number, message = ""): number {
  const error = message.toLowerCase();
  const exponent = Math.max(0, Math.min(6, Math.trunc(attempt) - 1));
  if (/rate.?limit|too many requests|http 429|\b429\b/.test(error)) {
    return Math.min(10_000, 1_500 * (2 ** Math.min(exponent, 3)));
  }
  if (/off quotes|requote|price changed|price moved|quote expired|price deviation|market price changed/.test(error)) {
    return Math.min(2_000, 200 * (2 ** Math.min(exponent, 4)));
  }
  return Math.min(TS_CLOSE_RETRY_MAX_MS, TS_CLOSE_RETRY_BASE_MS * (2 ** exponent));
}

export function indicatesPositionAlreadyClosed(message: string): boolean {
  return /position.{0,30}(not found|does not exist|doesn't exist|already closed|is closed|not open)|already.{0,20}closed|no such position/i.test(message);
}

export interface ManagedPosition {
  positionId: string;
  symbol: string;
  side: PositionSide;
  entry: number;
  volume: number;
  step: number;
  digits: number;
  pip: number;

  /** Broker emergency stop; tightened after profit-lock activation when allowed. */
  emergencySl: number;
  slOrderId?: string;

  /** program-side virtual trailing stop; never loosens */
  trailStop: number;
  trailDistance: number;
  best: number;
  atr: number;
  trailActivated?: boolean;
  /** Current broker-stop risk in USD; recalculated from the broker SL before each new entry. */
  riskUsd?: number;
  /** USD value of one pip per lot, captured from contract metadata at open. */
  pipValueUsdPerLot?: number;
  lastBrokerStopMoveAt?: number;

  openedAt: number;
  /** boundary of the last trail ATR refresh */
  lastAtrSyncAt: number;
  lastStopEnsureAt: number;
  lastError?: string;
  closing?: boolean;
  /** TS-triggered close request retained while another broker mutation is busy. */
  closeRequested?: string;
  /** Prevent repeated market-close requests on every tick after a broker error. */
  closeRetryAt?: number;
  /** Consecutive confirmed close failures; drives bounded retry backoff. */
  closeAttempts?: number;
  /** Consecutive manage ticks where the broker snapshot did not show the position. */
  misses?: number;
  score: number;
}

export interface RealizedStats {
  trades: number;
  wins: number;
  losses: number;
  flats: number;
  netProfit: number;
  consecutiveLosses: number;
}

export interface TradeLogEntry {
  at: number;
  action: "open" | "close" | "trail" | "protect" | "skip" | "error";
  symbol?: string;
  positionId?: string;
  side?: string;
  volume?: number;
  price?: number;
  sl?: number;
  riskUsd?: number;
  reason?: string;
  ok?: boolean;
}

export interface ExecutorState {
  managed: ManagedPosition[];
  stats: RealizedStats;
  trailing: Array<{ at: number; symbol: string; positionId: string; sl: number }>;
  tradeLog: TradeLogEntry[];
}

export interface ExecutorDeps {
  tools: TradeTools;
  /** read-only market tools, used to refresh the trailing ATR */
  marketTools: Tools;
  ticks: TickHub;
  equity: EquityTracker;
  events: EventHub;
  client: ExnessClient;
  config: AgentConfig;
  accountId: string;
  cacheDir: string;
  live: boolean;
  journal?: AgentJournal;
  log: (line: string) => void;
}

export interface SizingInput {
  equity: number;
  riskPct: number;
  slPips: number;
  pipValuePerLot: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  maxLots: number;
  /** Remaining account-wide open-risk budget, USD. */
  riskBudgetUsd?: number;
}

export interface SizingResult {
  lots: number;
  riskUsd: number;
  reason?: string;
}

/**
 * Fixed-fractional sizing on the USD-converted account risk basis. Always
 * floors to the volume step so a trade never intentionally exceeds risk limits.
 */
export function computeLots(input: SizingInput): SizingResult {
  if (!(input.slPips > 0) || !(input.pipValuePerLot > 0) || !(input.volumeStep > 0)) {
    return { lots: 0, riskUsd: 0, reason: "invalid sizing inputs" };
  }
  const perTradeRiskUsd = (input.equity * input.riskPct) / 100;
  const riskUsd = input.riskBudgetUsd === undefined
    ? perTradeRiskUsd
    : Math.min(perTradeRiskUsd, Math.max(0, input.riskBudgetUsd));
  if (!(riskUsd > 0)) {
    return { lots: 0, riskUsd: 0, reason: "no remaining aggregate open-risk budget" };
  }
  const rawLots = riskUsd / (input.slPips * input.pipValuePerLot);
  let lots = roundVolumeDown(Math.min(rawLots, input.maxLots), input.volumeStep);
  if (lots > input.volumeMax) lots = roundVolumeDown(input.volumeMax, input.volumeStep);
  if (lots < input.volumeMin) {
    // On small accounts, the configured percentage may calculate less than
    // the broker's minimum order size even though a minimum lot still fits
    // inside the account-wide risk cap. Allow that minimum lot only when its
    // actual stop-loss risk fits the remaining aggregate budget.
    const minimumLots = Number((
      Math.ceil((input.volumeMin - 1e-10) / input.volumeStep) * input.volumeStep
    ).toFixed(8));
    const minimumLotRiskUsd = minimumLots * input.slPips * input.pipValuePerLot;
    const volumeCeiling = Math.min(input.volumeMax, input.maxLots);
    const availableBudgetUsd = input.riskBudgetUsd ?? perTradeRiskUsd;
    const riskToleranceUsd = Math.max(1e-8, availableBudgetUsd * 1e-9);
    if (
      input.riskBudgetUsd !== undefined &&
      minimumLots >= input.volumeMin &&
      minimumLots <= volumeCeiling + 1e-10 &&
      minimumLotRiskUsd <= availableBudgetUsd + riskToleranceUsd
    ) {
      return { lots: minimumLots, riskUsd: minimumLotRiskUsd };
    }
    return {
      lots: 0,
      riskUsd,
      reason: input.riskBudgetUsd !== undefined
        ? `broker minimum ${minimumLots} lot risks ${minimumLotRiskUsd.toFixed(2)} USD; remaining aggregate budget ${availableBudgetUsd.toFixed(2)} USD (per-trade target ${perTradeRiskUsd.toFixed(2)} USD); minimum lot does not fit safely`
        : `risk ${riskUsd.toFixed(2)} USD supports ${rawLots.toFixed(4)} lot < volume_min ${input.volumeMin}; broker minimum lot cannot fit the configured per-trade risk`,
    };
  }
  return { lots, riskUsd: lots * input.slPips * input.pipValuePerLot };
}

/** Rate used to convert the instrument's quote currency into USD. */
export function quoteToUsdRate(
  quoteCurrency: string,
  quotes: Map<string, Quote>,
): number | undefined {
  if (quoteCurrency === "USD") return 1;
  const direct = quotes.get(`${quoteCurrency}USD`);
  if (direct && direct.bid > 0) return direct.bid;
  const inverse = quotes.get(`USD${quoteCurrency}`);
  if (inverse && inverse.ask > 0) return 1 / inverse.ask;

  // Triangulate through a liquid USD pair. Example: CAD -> USD can be derived
  // from CADJPY / USDJPY even when the synthetic CADUSD symbol does not exist
  // or has not ticked yet. Sell the quote currency and buy USD, hence bid/ask.
  for (const pivot of ["JPY", "CHF", "EUR", "GBP", "AUD", "NZD", "CAD"]) {
    if (pivot === quoteCurrency) continue;
    const quotePivot = quotes.get(`${quoteCurrency}${pivot}`);
    const usdPivot = quotes.get(`USD${pivot}`);
    if (quotePivot && usdPivot && quotePivot.bid > 0 && usdPivot.ask > 0) {
      const rate = quotePivot.bid / usdPivot.ask;
      if (Number.isFinite(rate) && rate > 0) return rate;
    }
    const pivotQuote = quotes.get(`${pivot}${quoteCurrency}`);
    const pivotUsd = quotes.get(`${pivot}USD`);
    if (pivotQuote && pivotUsd && pivotQuote.ask > 0 && pivotUsd.bid > 0) {
      const rate = pivotUsd.bid / pivotQuote.ask;
      if (Number.isFinite(rate) && rate > 0) return rate;
    }
  }
  return undefined;
}

/** USD value of one base-currency unit, used for a conservative margin check. */
export function baseToUsdRate(
  baseCurrency: string,
  price: number,
  quoteCurrency: string,
  quotes: Map<string, Quote>,
): number | undefined {
  if (baseCurrency === "USD") return 1;
  const direct = quotes.get(`${baseCurrency}USD`);
  if (direct && direct.bid > 0) return direct.bid;
  const inverse = quotes.get(`USD${baseCurrency}`);
  if (inverse && inverse.ask > 0) return 1 / inverse.ask;
  const quoteRate = quoteToUsdRate(quoteCurrency, quotes);
  if (quoteRate !== undefined && price > 0) return price * quoteRate;
  return undefined;
}

function parseNumber(value: string | null | undefined, fallback: number): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dealProfit(deal: Deal): number {
  const profit = Number(deal.profit?.amount ?? 0);
  const commission = Number(deal.commission ?? 0);
  return (Number.isFinite(profit) ? profit : 0) + (Number.isFinite(commission) ? commission : 0);
}

function candleBoundary(timeframe: Timeframe, now = Date.now()): number {
  const duration = timeframeMs(timeframe);
  return Math.floor(now / duration) * duration;
}

function roundStopAway(value: number, digits: number, side: PositionSide): number {
  const factor = 10 ** digits;
  return (side === "buy" ? Math.floor(value * factor) : Math.ceil(value * factor)) / factor;
}

function improved(side: PositionSide, next: number, current: number, epsilon: number): boolean {
  return side === "buy" ? next > current + epsilon : next < current - epsilon;
}

export class RiskExecutor {
  readonly managed = new Map<string, ManagedPosition>();
  stats: RealizedStats = {
    trades: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    netProfit: 0,
    consecutiveLosses: 0,
  };

  private readonly busy = new Set<string>();
  private readonly realized = new Map<string, number>();
  private readonly killAttempts = new Map<string, number>();
  /** Recently closed position ids; prevents re-adopting a lagging snapshot row. */
  private readonly recentlyFinalized = new Map<string, number>();
  /** Backoff for positions that could not be adopted yet (missing data/API error). */
  private readonly adoptRetryAt = new Map<string, number>();
  private syncing = false;
  private trailing: Array<{ at: number; symbol: string; positionId: string; sl: number }> = [];
  private tradeLog: TradeLogEntry[] = [];

  constructor(private readonly deps: ExecutorDeps) {
    deps.events.on((event) => this.trackDeals(event.raw));
  }

  // ------------------------------------------------------------------ state

  restore(state: Partial<ExecutorState> | null | undefined): void {
    if (!state) return;
    if (state.stats) this.stats = { ...this.stats, ...state.stats };
    if (Array.isArray(state.trailing)) this.trailing = state.trailing.slice(-20);
    if (Array.isArray(state.tradeLog)) this.tradeLog = state.tradeLog.slice(-50);

    for (const position of state.managed ?? []) {
      if (!position.positionId || !position.symbol) continue;
      const entry = Number(position.entry);
      if (!Number.isFinite(entry) || entry <= 0) continue;

      const side: PositionSide = position.side === "sell" ? "sell" : "buy";
      const sign = side === "buy" ? 1 : -1;
      const digits = Number(position.digits) || 5;
      const pip = Number(position.pip) || pipSize(position.symbol, digits);
      const trailDistance =
        Number(position.trailDistance) > 0
          ? Number(position.trailDistance)
          : this.deps.config.trailMinPips * pip;
      const atrValue =
        Number(position.atr) > 0
          ? Number(position.atr)
          : trailDistance / Math.max(1, this.deps.config.trailAtrFactor);
      const emergencySl =
        Number(position.emergencySl) > 0
          ? Number(position.emergencySl)
          : entry - sign * Math.max(atrValue * this.deps.config.emergencySlAtrFactor, pip);
      const initialStop = initialVirtualStop(side, entry, trailDistance);
      const savedStop = Number(position.trailStop);
      // Keep a previously locked-in-profit stop, but migrate old emergency-SL
      // values to the nearer entry-anchored virtual stop.
      const trailStop = Number.isFinite(savedStop) && savedStop > 0
        ? (side === "buy" ? Math.max(initialStop, savedStop) : Math.min(initialStop, savedStop))
        : initialStop;
      const savedRiskUsd = Number(position.riskUsd);
      const originalOpen = [...this.tradeLog].reverse().find(
        (entry) => entry.action === "open" && entry.positionId === position.positionId,
      );
      const originalEntry = Number(originalOpen?.price);
      const originalStop = Number(originalOpen?.sl);
      const originalVolume = Number(originalOpen?.volume) > 0
        ? Number(originalOpen?.volume)
        : Number(position.volume);
      const originalStopPips = originalEntry > 0 && originalStop > 0
        ? Math.abs(originalEntry - originalStop) / pip
        : 0;
      const inferredPipValueUsdPerLot = savedRiskUsd > 0 && originalStopPips > 0 && originalVolume > 0
        ? savedRiskUsd / (originalStopPips * originalVolume)
        : undefined;
      const storedPipValueUsdPerLot = Number(position.pipValueUsdPerLot);
      const wasAlreadyProtected = canMoveTrailStop(
        side,
        trailStop,
        entry,
        false,
        this.deps.config.profitLockMinPips * pip,
      );

      this.managed.set(position.positionId, {
        positionId: position.positionId,
        symbol: position.symbol,
        side,
        entry,
        volume: Number(position.volume) || 0,
        step: Number(position.step) || 0.01,
        digits,
        pip,
        emergencySl,
        slOrderId: position.slOrderId,
        trailStop,
        trailDistance,
        best: Number(position.best) || entry,
        atr: atrValue,
        trailActivated: typeof position.trailActivated === "boolean"
          ? position.trailActivated
          : wasAlreadyProtected,
        riskUsd: savedRiskUsd >= 0 ? savedRiskUsd : undefined,
        pipValueUsdPerLot: storedPipValueUsdPerLot > 0
          ? storedPipValueUsdPerLot
          : inferredPipValueUsdPerLot,
        lastBrokerStopMoveAt: 0,
        openedAt: Number(position.openedAt) || Date.now(),
        // Force a fresh trail ATR read on the first manage tick after a restart.
        lastAtrSyncAt: 0,
        lastStopEnsureAt: 0,
        score: Number(position.score) || 0,
        closing: false,
        closeRequested: typeof position.closeRequested === "string" ? position.closeRequested : undefined,
        closeRetryAt: Number(position.closeRetryAt) > 0 ? Number(position.closeRetryAt) : undefined,
        closeAttempts: Number(position.closeAttempts) > 0 ? Math.trunc(Number(position.closeAttempts)) : 0,
      });
    }
  }

  statePayload(): ExecutorState {
    return {
      managed: [...this.managed.values()],
      stats: { ...this.stats },
      trailing: this.trailing.slice(-20),
      tradeLog: this.tradeLog.slice(-50),
    };
  }

  private killActive(): boolean {
    return fs.existsSync(path.join(this.deps.cacheDir, "KILL"));
  }

  // --------------------------------------------------------------- gating

  tradingAllowed(view: AccountView): { ok: boolean; reason?: string } {
    if (this.killActive()) {
      return { ok: false, reason: "kill switch (.cache/KILL)" };
    }
    if (view.tradeMode !== "enabled") return { ok: false, reason: `trade_mode ${view.tradeMode}` };
    if (view.status !== "active") return { ok: false, reason: `status ${view.status}` };
    if (this.deps.config.maxDailyLossPct > 0 && view.equity > 0) {
      const today = new Date().toDateString();
      const firstToday = this.deps.equity.samples.find(
        (sample) => new Date(sample.t).toDateString() === today,
      );
      const dayStart = firstToday?.balance ?? view.balance;
      const loss = dayStart - view.equity;
      const limit = dayStart * this.deps.config.maxDailyLossPct / 100;
      if (dayStart > 0 && loss >= limit) {
        return {
          ok: false,
          reason: `daily loss limit reached ${loss.toFixed(2)} / ${limit.toFixed(2)} ${view.currency}; new entries paused`,
        };
      }
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- open

  /**
   * Recalculate aggregate risk from each managed position's latest known
   * broker-side stop. TS VIRT is deliberately never used as a risk-reducing SL.
   */
  private recalculateManagedOpenRisk(view: AccountView): { riskUsd: number; reason?: string } {
    let totalUsd = 0;
    for (const managed of this.managed.values()) {
      const position = view.positions.find((entry) => entry.position_id === managed.positionId);
      const sltp = view.orders.find(
        (order) => order.order_type === "sltp" &&
          order.position_id === managed.positionId && order.state === "placed",
      );
      const positionStop = Number(position?.stop_loss_price ?? 0);
      const orderStop = Number(sltp?.stop_loss_price ?? 0);
      // emergencySl is the last confirmed broker SL sent with the position or
      // acknowledged by a later SL modification; it is not the virtual trail.
      const brokerStop = orderStop > 0 ? orderStop : positionStop > 0 ? positionStop : managed.emergencySl;
      const pipValue = Number(managed.pipValueUsdPerLot);
      const volume = parseNumber(position?.volume, managed.volume);
      const entry = parseNumber(position?.open_price, managed.entry);
      if (!(brokerStop > 0) || !(pipValue > 0) || !(managed.pip > 0) || !(volume > 0) || !(entry > 0)) {
        return {
          riskUsd: totalUsd,
          reason: `open position risk metadata unavailable for ${managed.symbol}; cannot verify broker-stop risk safely`,
        };
      }
      const adverseDistance = managed.side === "buy"
        ? Math.max(0, entry - brokerStop)
        : Math.max(0, brokerStop - entry);
      const riskUsd = (adverseDistance / managed.pip) * volume * pipValue;
      if (!Number.isFinite(riskUsd) || riskUsd < 0) {
        return {
          riskUsd: totalUsd,
          reason: `invalid broker-stop risk for ${managed.symbol}; cannot add risk safely`,
        };
      }
      managed.riskUsd = riskUsd;
      totalUsd += riskUsd;
    }
    return { riskUsd: totalUsd };
  }

  async open(
    signal: EntrySignal,
    view: AccountView,
  ): Promise<{ ok: boolean; reason?: string; managed?: ManagedPosition; result?: OperationResult }> {
    if (!this.deps.live) return { ok: false, reason: "dry-run: orders disabled" };
    const gate = this.tradingAllowed(view);
    if (!gate.ok) return { ok: false, reason: gate.reason };
    if (Date.now() > signal.expiresAt) return { ok: false, reason: "signal expired" };
    // Repeated entries on the same symbol and any total position count are allowed.
    // Aggregate open risk, per-trade sizing, free margin, and daily-loss limits
    // below remain the account-level safety gates.
    const managedIds = new Set(this.managed.keys());
    if (view.positions.some((position) => !managedIds.has(position.position_id))) {
      return { ok: false, reason: "unmanaged position present; total account risk cannot be verified" };
    }

    let quote = this.deps.ticks.get(signal.symbol);
    if (!quote || Date.now() - quote.timestamp > this.deps.config.maxQuoteAgeMs) {
      return { ok: false, reason: "quote stale" };
    }
    if (!spreadWithinLimit(signal.symbol, quote, this.deps.config)) {
      return { ok: false, reason: "spread too wide" };
    }
    // The signal's entry must still be reachable; otherwise the setup is gone.
    // Compare the price we would actually pay/receive (not the mid), so the
    // normal bid/ask spread never counts as a chase.
    let execution = signal.side === "buy" ? quote.ask : quote.bid;
    if (Math.abs(execution - signal.entry) > this.deps.config.maxChaseAtr * signal.atr) {
      return { ok: false, reason: "entry moved too far" };
    }

    let conditions;
    try {
      conditions = await this.deps.tools.conditions(signal.symbol);
    } catch (error) {
      return { ok: false, reason: `conditions: ${error instanceof Error ? error.message : error}` };
    }

    const digits = conditions.point_digits ?? signal.digits;
    const pip = pipSize(signal.symbol, digits);
    // Round the emergency stop with the broker's real precision, away from the
    // entry. This is the exact value sent in the order and shown on the board.
    const stopSign = signal.side === "buy" ? 1 : -1;
    // Re-anchor the emergency SL to the executable price at order time. A
    // signal can wait behind REST/API work, so never size against a stale stop.
    const emergencyDistance = Math.max(
      this.deps.config.emergencySlAtrFactor * signal.atr,
      this.deps.config.minStopPips * pip,
      quote.spread * 3,
    );
    let emergencySl = roundStopAway(
      execution - stopSign * emergencyDistance,
      digits,
      signal.side,
    );
    if (
      (signal.side === "buy" && emergencySl >= execution) ||
      (signal.side === "sell" && emergencySl <= execution)
    ) {
      return { ok: false, reason: "emergency SL is not on the protective side of the current price" };
    }
    const contractSize = parseNumber(conditions.contract_size, 0);
    if (!(contractSize > 0)) {
      return { ok: false, reason: "instrument contract size unavailable; refusing unsafe sizing" };
    }
    const volumeMin = parseNumber(conditions.volume_min, 0.01);
    const volumeMax = parseNumber(conditions.volume_max, 100);
    const volumeStep = parseNumber(conditions.volume_step, 0.01);
    const quoteCurrency = conditions.quote_currency ?? signal.symbol.slice(3);
    const baseCurrency = conditions.base_currency ?? signal.symbol.slice(0, 3);

    let quotes = new Map(this.deps.ticks.store.all().map((entry) => [entry.symbol, entry] as const));
    let quoteRate = quoteToUsdRate(quoteCurrency, quotes);
    if (quoteRate === undefined && quoteCurrency !== "USD") {
      // The conversion pair may simply not have ticked yet on a wide universe.
      await this.deps.ticks
        .ensure([`${quoteCurrency}USD`, `USD${quoteCurrency}`], 1500)
        .catch(() => []);
      quotes = new Map(this.deps.ticks.store.all().map((entry) => [entry.symbol, entry] as const));
      quoteRate = quoteToUsdRate(quoteCurrency, quotes);
    }
    if (quoteRate === undefined) {
      return { ok: false, reason: `no ${quoteCurrency}/USD conversion for sizing` };
    }
    let accountCurrencyToUsd = quoteToUsdRate(view.currency.toUpperCase(), quotes);
    if (accountCurrencyToUsd === undefined && view.currency.toUpperCase() !== "USD") {
      await this.deps.ticks
        .ensure([`${view.currency.toUpperCase()}USD`, `USD${view.currency.toUpperCase()}`], 1500)
        .catch(() => []);
      quotes = new Map(this.deps.ticks.store.all().map((entry) => [entry.symbol, entry] as const));
      accountCurrencyToUsd = quoteToUsdRate(view.currency.toUpperCase(), quotes);
    }
    if (!(accountCurrencyToUsd && accountCurrencyToUsd > 0)) {
      return { ok: false, reason: `no USD conversion for account currency ${view.currency}` };
    }
    if (!(view.balance > 0) || !(view.equity > 0) || !(view.freeMargin > 0)) {
      return { ok: false, reason: "balance/equity/free margin not sufficient" };
    }

    const leverage = Number(view.leverage);
    if (!Number.isFinite(leverage) || leverage <= 0) {
      return { ok: false, reason: `invalid account leverage ${view.leverage}; refusing unsafe margin fallback` };
    }
    const pipValuePerLot = contractSize * pip * quoteRate;
    const sizingSlPips = Math.abs(execution - emergencySl) / pip;
    const riskEquityUsd = Math.min(view.balance, view.equity) * accountCurrencyToUsd;
    const maxOpenRiskUsd = riskEquityUsd * this.deps.config.maxOpenRiskPct / 100;
    const currentRisk = this.recalculateManagedOpenRisk(view);
    if (currentRisk.reason) return { ok: false, reason: currentRisk.reason };
    const openRiskUsd = currentRisk.riskUsd;
    const remainingRiskUsd = maxOpenRiskUsd - openRiskUsd;
    if (!(remainingRiskUsd > 0.000001)) {
      return {
        ok: false,
        reason: `open risk cap ${openRiskUsd.toFixed(2)} >= ${maxOpenRiskUsd.toFixed(2)} USD; no remaining aggregate risk budget`,
      };
    }
    const sizing = computeLots({
      equity: riskEquityUsd,
      riskPct: this.deps.config.riskPct,
      slPips: sizingSlPips,
      pipValuePerLot,
      volumeMin,
      volumeMax,
      volumeStep,
      maxLots: this.deps.config.maxLotsPerTrade,
      riskBudgetUsd: remainingRiskUsd,
    });
    if (sizing.reason || sizing.lots <= 0) {
      return { ok: false, reason: sizing.reason ?? "size 0" };
    }

    const baseRate = baseToUsdRate(baseCurrency, quote.mid, quoteCurrency, quotes);
    if (!(baseRate && baseRate > 0)) {
      return { ok: false, reason: `no USD conversion for margin currency ${baseCurrency}` };
    }
    // Convert notional from USD to account currency, then reserve free margin.
    const marginPerLotAccount = (contractSize * baseRate) / leverage / accountCurrencyToUsd;
    if (!(marginPerLotAccount > 0) || !Number.isFinite(marginPerLotAccount)) {
      return { ok: false, reason: "invalid margin estimate" };
    }
    const usableMargin = Math.max(0, view.freeMargin) *
      (1 - this.deps.config.marginReservePct / 100) /
      Math.max(1, this.deps.config.marginBuffer);
    const marginLots = roundVolumeDown(usableMargin / marginPerLotAccount, volumeStep);
    const finalLots = Math.min(sizing.lots, marginLots);
    if (finalLots < volumeMin) {
      return {
        ok: false,
        reason: `free margin cap: ${view.freeMargin.toFixed(2)} ${view.currency}, reserve ${this.deps.config.marginReservePct}%`,
      };
    }

    const plannedRiskUsd = finalLots * sizingSlPips * pipValuePerLot;
    if (openRiskUsd + plannedRiskUsd > maxOpenRiskUsd + Math.max(0.000001, maxOpenRiskUsd * 1e-9)) {
      return {
        ok: false,
        reason: `open risk cap ${openRiskUsd.toFixed(2)} + ${plannedRiskUsd.toFixed(2)} > ${maxOpenRiskUsd.toFixed(2)} USD after lot rounding`,
      };
    }

    // Conditions, conversion rates and account sizing may take several seconds.
    // Re-read the executable quote immediately before submitting the market order.
    const latestQuote = this.deps.ticks.get(signal.symbol);
    if (!latestQuote || Date.now() - latestQuote.timestamp > this.deps.config.maxQuoteAgeMs) {
      return { ok: false, reason: "quote stale during sizing; retry next scan" };
    }
    if (!spreadWithinLimit(signal.symbol, latestQuote, this.deps.config)) {
      return { ok: false, reason: "spread changed during sizing; retry next scan" };
    }
    const latestSpreadTrailRatio = latestQuote.spread / signal.trailDistance;
    if (
      !Number.isFinite(latestSpreadTrailRatio) ||
      latestSpreadTrailRatio > this.deps.config.maxSpreadTrailRatio
    ) {
      return {
        ok: false,
        reason: `spread cost ${(latestSpreadTrailRatio * 100).toFixed(0)}% of trail during sizing; retry next scan`,
      };
    }
    const latestExecution = signal.side === "buy" ? latestQuote.ask : latestQuote.bid;
    if (Math.abs(latestExecution - signal.entry) > this.deps.config.maxChaseAtr * signal.atr) {
      return { ok: false, reason: "entry moved too far during sizing; retry next scan" };
    }
    const latestEmergencyDistance = Math.max(
      this.deps.config.emergencySlAtrFactor * signal.atr,
      this.deps.config.minStopPips * pip,
      latestQuote.spread * 3,
    );
    // If the spread widened enough to require a wider stop, don't send a lot
    // size calculated against the old, smaller risk distance.
    if (latestEmergencyDistance > emergencyDistance + pip * 0.01) {
      return { ok: false, reason: "spread widened during sizing; stop and lot need recalculation" };
    }
    quote = latestQuote;
    execution = latestExecution;
    emergencySl = roundStopAway(
      execution - stopSign * emergencyDistance,
      digits,
      signal.side,
    );
    if (
      (signal.side === "buy" && emergencySl >= execution) ||
      (signal.side === "sell" && emergencySl <= execution)
    ) {
      return { ok: false, reason: "latest emergency SL is not protective" };
    }

    const beforeIds = new Set(view.positions.map((position) => position.position_id));
    const result = await this.deps.tools.open({
      symbol: signal.symbol,
      side: signal.side,
      volume: finalLots,
      stopLoss: emergencySl,
      comment: `ot-${signal.side}-${signal.score.toFixed(0)}`,
    });

    if (!result.ok) {
      this.log({
        at: Date.now(),
        action: "error",
        symbol: signal.symbol,
        side: signal.side,
        reason: `open rejected ${result.errorCode ?? ""} ${result.errorMessage ?? result.status}`.trim(),
        ok: false,
      });
      return { ok: false, reason: result.errorMessage ?? result.status, result };
    }

    let position = this.findOpenedPosition(result, signal.symbol, beforeIds);
    if (!position) {
      this.deps.tools.invalidateSnapshot();
      try {
        const fresh = await this.deps.tools.view(true);
        position = fresh.positions.find(
          (entry) => entry.instrument === signal.symbol && !beforeIds.has(entry.position_id),
        );
      } catch {
        // fall through: the position exists but the snapshot is rate limited
      }
    }
    if (!position) {
      return { ok: false, reason: "confirmed but position not found", result };
    }

    const entry = Number(position.open_price ?? signal.entry);
    const sltp = result.data?.orders?.find(
      (order) => order.order_type === "sltp" && order.position_id === position!.position_id,
    );
    const trailDistance = Math.max(
      signal.trailDistance,
      this.deps.config.trailMinPips * pip,
    );
    const managed: ManagedPosition = {
      positionId: position.position_id,
      symbol: signal.symbol,
      side: signal.side,
      entry,
      volume: Number(position.volume) > 0 ? Number(position.volume) : finalLots,
      step: volumeStep,
      digits,
      pip,
      emergencySl,
      slOrderId: sltp?.order_id,
      trailStop: initialVirtualStop(signal.side, entry, trailDistance),
      trailDistance,
      best: signal.side === "buy" ? Math.max(entry, quote.bid) : Math.min(entry, quote.ask),
      atr: signal.atr,
      trailActivated: false,
      riskUsd: (Number(position.volume) > 0 ? Number(position.volume) : finalLots) *
        (Math.abs(entry - emergencySl) / pip) * pipValuePerLot,
      pipValueUsdPerLot: pipValuePerLot,
      lastBrokerStopMoveAt: 0,
      openedAt: Date.now(),
      lastAtrSyncAt: candleBoundary(this.deps.config.trailTimeframe),
      lastStopEnsureAt: sltp?.order_id ? Date.now() : 0,
      score: signal.score,
    };
    this.managed.set(managed.positionId, managed);

    this.log({
      at: Date.now(),
      action: "open",
      symbol: managed.symbol,
      positionId: managed.positionId,
      side: managed.side,
      volume: managed.volume,
      price: entry,
      sl: managed.emergencySl,
      riskUsd: managed.riskUsd,
      reason:
        `${signal.setupType} · risk ${Number(managed.riskUsd ?? 0).toFixed(2)} USD · emergency ${(Math.abs(entry - emergencySl) / pip).toFixed(1)}p · ` +
        `trail ${(trailDistance / pip).toFixed(1)}p · score ${signal.score.toFixed(1)}`,
      ok: true,
    });
    // A cached snapshot from before the open does not contain the new position;
    // mark it dirty so the manage loop cannot mistake it for a closed trade.
    this.deps.tools.invalidateSnapshot();
    return { ok: true, managed, result };
  }

  // ---------------------------------------------------------------- manage

  /**
   * Dynamic reconciliation: the broker snapshot is the source of truth. Any
   * open position the bot does not track yet is adopted from broker data, no
   * matter which terminal or person opened it. This removes the unmanaged-position
   * entry gate and lets TS manage the whole account.
   */
  async syncPositions(view: AccountView): Promise<void> {
    // Manage ticks and the scan loop can fire together. Serialize adoption so
    // two callers never create (and pay for) the same emergency SL.
    if (this.syncing) return;
    this.syncing = true;
    try {
      const now = Date.now();
      for (const [positionId, at] of this.recentlyFinalized) {
        if (now - at > 60_000) this.recentlyFinalized.delete(positionId);
      }
      const openIds = new Set(view.positions.map((position) => position.position_id));
      for (const positionId of [...this.adoptRetryAt.keys()]) {
        if (!openIds.has(positionId)) this.adoptRetryAt.delete(positionId);
      }

      for (const position of view.positions) {
        if (position.state !== "open") continue;
        if (this.managed.has(position.position_id)) continue;
        if (this.recentlyFinalized.has(position.position_id)) continue;
        if ((this.adoptRetryAt.get(position.position_id) ?? 0) > now) continue;
        const adopted = await this.adoptPosition(position, view, now);
        if (!adopted) this.adoptRetryAt.set(position.position_id, Date.now() + 30_000);
      }
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Build a managed position from the broker snapshot. Missing broker SLs are
   * created from ATR/spread immediately so the position is never left naked.
   * Returns false when conditions or USD conversion are unavailable; the entry
   * gate then stays closed until risk can be verified.
   */
  private async adoptPosition(
    position: Position,
    view: AccountView,
    now: number,
  ): Promise<boolean> {
    const symbol = position.instrument;
    const side: PositionSide = position.direction === "sell" ? "sell" : "buy";
    const sign = side === "buy" ? 1 : -1;
    const entry = parseNumber(position.open_price, 0);
    const volume = parseNumber(position.volume, 0);
    if (!(entry > 0) || !(volume > 0)) return false;

    let conditions;
    try {
      conditions = await this.deps.tools.conditions(symbol);
    } catch (error) {
      this.deps.log(
        `adopt ${symbol} deferred: conditions ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const digits = Number(conditions.point_digits) || digitsFor(symbol);
    const pip = pipSize(symbol, digits);
    const step = parseNumber(conditions.volume_step, 0.01);
    const contractSize = parseNumber(conditions.contract_size, 0);
    if (!(contractSize > 0)) {
      this.deps.log(`adopt ${symbol} deferred: contract size unavailable`);
      return false;
    }

    const quoteCurrency = conditions.quote_currency ?? symbol.slice(3);
    let quotes = new Map(this.deps.ticks.store.all().map((item) => [item.symbol, item] as const));
    let quoteRate = quoteToUsdRate(quoteCurrency, quotes);
    if (quoteRate === undefined && quoteCurrency !== "USD") {
      await this.deps.ticks
        .ensure([`${quoteCurrency}USD`, `USD${quoteCurrency}`], 1500)
        .catch(() => []);
      quotes = new Map(this.deps.ticks.store.all().map((item) => [item.symbol, item] as const));
      quoteRate = quoteToUsdRate(quoteCurrency, quotes);
    }
    if (!(quoteRate && quoteRate > 0)) {
      this.deps.log(`adopt ${symbol} deferred: no ${quoteCurrency}/USD conversion`);
      return false;
    }
    const pipValueUsdPerLot = contractSize * pip * quoteRate;

    // Fresh ATR gives the trail its natural distance. When candles are
    // unavailable the broker stop (or configured minimum) is used instead.
    let atrValue = 0;
    const candles = await this.deps.marketTools.get_candles({
      symbol,
      timeframe: this.deps.config.trailTimeframe,
      n: 60,
    });
    if (candles.ok) {
      const closed = dropFormingCandle(
        candles.data,
        timeframeMs(this.deps.config.trailTimeframe),
      );
      const value = lastFinite(atr(closed, this.deps.config.trailAtrPeriod));
      if (value !== undefined && value > 0) atrValue = value;
    }

    const sltp = view.orders.find(
      (order) =>
        order.order_type === "sltp" &&
        order.position_id === position.position_id &&
        order.state === "placed",
    );
    const brokerSl = parseNumber(
      sltp?.stop_loss_price ?? position.stop_loss_price ?? undefined,
      0,
    );
    const quote = this.deps.ticks.get(symbol);
    const spread = Number(quote?.spread ?? 0);
    let emergencySl = brokerSl;
    let slOrderId = sltp?.order_id;
    let createdStop = false;

    if (!(emergencySl > 0)) {
      const distance = Math.max(
        atrValue > 0 ? this.deps.config.emergencySlAtrFactor * atrValue : 0,
        this.deps.config.minStopPips * pip,
        Number.isFinite(spread) ? spread * 3 : 0,
      );
      emergencySl = roundStopAway(entry - sign * distance, digits, side);
      const result = await this.deps.tools.setSltp(position.position_id, emergencySl, digits);
      if (!result.ok) {
        this.deps.log(
          `adopt ${symbol} deferred: emergency SL rejected ${result.errorMessage ?? result.status}`,
        );
        this.deps.tools.invalidateSnapshot();
        return false;
      }
      slOrderId = result.data?.orders?.find((order) => order.order_type === "sltp")?.order_id;
      createdStop = true;
      this.deps.tools.invalidateSnapshot();
    }

    const stopDistance = Math.abs(entry - emergencySl);
    const impliedAtr = atrValue > 0
      ? atrValue
      : Math.max(
          stopDistance / Math.max(1, this.deps.config.emergencySlAtrFactor),
          this.deps.config.trailMinPips * pip,
        );
    const trailDistance = trailDistanceFromAtr(
      impliedAtr,
      this.deps.config.trailAtrFactor,
      this.deps.config.trailMinPips * pip,
    );
    const initialStop = initialVirtualStop(side, entry, trailDistance);
    const trailStop = side === "buy"
      ? Math.max(initialStop, emergencySl)
      : Math.min(initialStop, emergencySl);
    const best = quote
      ? (side === "buy" ? Math.max(entry, quote.bid) : Math.min(entry, quote.ask))
      : entry;

    const managed: ManagedPosition = {
      positionId: position.position_id,
      symbol,
      side,
      entry,
      volume,
      step,
      digits,
      pip,
      emergencySl,
      slOrderId,
      trailStop,
      trailDistance,
      best,
      atr: impliedAtr,
      trailActivated: virtualStopLocksProfit(side, trailStop, entry),
      riskUsd: (stopDistance / pip) * volume * pipValueUsdPerLot,
      pipValueUsdPerLot,
      lastBrokerStopMoveAt: 0,
      openedAt: Date.parse(position.create_time) || now,
      lastAtrSyncAt: atrValue > 0 ? candleBoundary(this.deps.config.trailTimeframe, now) : 0,
      lastStopEnsureAt: createdStop ? now : 0,
      score: 0,
    };
    this.managed.set(managed.positionId, managed);
    this.log({
      at: now,
      action: "open",
      symbol,
      positionId: managed.positionId,
      side,
      volume: managed.volume,
      price: managed.entry,
      sl: managed.emergencySl,
      riskUsd: managed.riskUsd,
      reason:
        `dynamic adopt · broker ${sltp ? "SL" : "position"} · ` +
        `risk ${Number(managed.riskUsd ?? 0).toFixed(2)} USD · trail ${(trailDistance / pip).toFixed(1)}p`,
      ok: true,
    });
    this.deps.log(
      `adopt ${symbol} ${side} ${managed.volume} lot (${managed.positionId}) · ${createdStop ? "SL created · " : ""}TS ${managed.trailStop}`,
    );
    return true;
  }

  /**
   * Kill switch: close every open position and stop entries. The KILL file is
   * persistent, so the agent keeps closing anything that appears while it is on.
   */
  private async closeAll(view: AccountView): Promise<void> {
    const now = Date.now();
    const openIds = new Set(view.positions.map((position) => position.position_id));

    for (const position of view.positions) {
      const lastAttempt = this.killAttempts.get(position.position_id) ?? 0;
      if (now - lastAttempt < 10_000) continue;
      this.killAttempts.set(position.position_id, now);
      const result = await this.deps.tools.close(position.position_id);
      if (result.ok) {
        this.log({
          at: Date.now(),
          action: "close",
          symbol: position.instrument,
          positionId: position.position_id,
          side: position.direction,
          volume: Number(position.volume),
          reason: "kill switch: close all",
          ok: true,
        });
      } else {
        this.killAttempts.delete(position.position_id);
        this.log({
          at: Date.now(),
          action: "error",
          symbol: position.instrument,
          positionId: position.position_id,
          reason: `kill close failed: ${result.errorMessage ?? result.status}`,
          ok: false,
        });
      }
    }

    for (const id of [...this.killAttempts.keys()]) {
      if (!openIds.has(id)) this.killAttempts.delete(id);
    }

    // If a managed position has disappeared from the broker, finalize its P/L
    // even while the kill switch is active.
    for (const managed of [...this.managed.values()]) {
      if (!openIds.has(managed.positionId)) await this.finalize(managed);
    }
  }

  /**
   * Consume each incoming tick so virtual TS is not limited to the slower
   * account-snapshot management cadence. The manager loop remains responsible
   * for broker-SL synchronization and ATR refreshes.
   */
  onQuote(quote: Quote): void {
    if (!this.deps.live) return;
    const now = Date.now();
    if (!isFreshQuote(quote.timestamp, now, this.deps.config.maxQuoteAgeMs)) return;

    for (const managed of this.managed.values()) {
      if (managed.symbol !== quote.symbol || managed.closing) continue;
      this.processTrailingQuote(managed, quote, now);
    }
  }

  private processTrailingQuote(managed: ManagedPosition, quote: Quote, now: number): void {
    if (managed.closing) return;
    if (managed.closeRequested) {
      void this.closeFull(managed, managed.closeRequested);
      return;
    }
    if (!isFreshQuote(quote.timestamp, now, this.deps.config.maxQuoteAgeMs)) return;

    const previousBest = managed.best;
    managed.best = updateBest(managed.side, managed.best, quote.bid, quote.ask);

    // Lock profit the moment the executable side clears entry by the spread
    // plus the configured minimum. Waiting for best - trailDistance would let
    // a small winner turn into a loser before TS ever protects it.
    const cushion = profitLockCushion(
      Number.isFinite(quote.spread) ? quote.spread : 0,
      this.deps.config.profitLockMinPips * managed.pip,
    );
    let activatedNow = false;
    if (!managed.trailActivated && cushion > 0) {
      const executable = managed.side === "buy" ? quote.bid : quote.ask;
      const profit = managed.side === "buy"
        ? executable - managed.entry
        : managed.entry - executable;
      const rawLock = profitLockStop(managed.side, managed.entry, cushion);
      if (Number.isFinite(profit) && profit >= cushion && Number.isFinite(rawLock)) {
        // Floor a BUY lock / ceil a SELL lock so rounding never shaves the cushion.
        const factor = 10 ** managed.digits;
        const lock = (managed.side === "buy"
          ? Math.floor(rawLock * factor)
          : Math.ceil(rawLock * factor)) / factor;
        if (
          canMoveTrailStop(managed.side, lock, managed.entry, false, 0) &&
          improved(managed.side, lock, managed.trailStop, managed.pip / 100)
        ) {
          managed.trailStop = lock;
          managed.trailActivated = true;
          activatedNow = true;
          this.log({
            at: now,
            action: "protect",
            symbol: managed.symbol,
            positionId: managed.positionId,
            side: managed.side,
            price: lock,
            reason:
              `TS VIRT locked ${(cushion / managed.pip).toFixed(1)}p beyond entry ` +
              `(spread ${(quote.spread / managed.pip).toFixed(1)}p paid)`,
            ok: true,
          });
        }
      }
    }

    this.advanceStop(
      managed,
      managed.best !== previousBest ? "best update" : "quote update",
      quote,
    );

    if (managed.trailActivated) {
      this.tightenProfitTrailDistance(managed, quote, activatedNow ? "first profit lock" : "live tick");
    }

    // Closing is event-driven: the same fresh tick that touches the virtual
    // stop starts the close request without waiting for the next manage timer.
    if (virtualStopHit(managed.side, managed.trailStop, quote.bid, quote.ask)) {
      managed.closeRequested ??= this.triggerReason(managed, quote);
      void this.closeFull(managed, managed.closeRequested);
    }
  }

  /**
   * After profit lock, reduce the trailing distance aggressively. The distance
   * may shrink as ATR/spread conditions improve, but can never widen again.
   */
  private tightenProfitTrailDistance(
    managed: ManagedPosition,
    quote: Quote,
    why: string,
  ): void {
    if (!managed.trailActivated || managed.closing || !(managed.atr > 0)) return;

    const nextDistance = profitTrailDistanceFromAtr(
      managed.trailDistance,
      managed.atr,
      this.deps.config.profitTrailAtrFactor,
      this.deps.config.profitTrailMinPips * managed.pip,
      quote.spread,
    );
    const minimumChange = managed.pip / 100;
    if (
      !Number.isFinite(nextDistance) ||
      nextDistance <= 0 ||
      managed.trailDistance - nextDistance < minimumChange
    ) return;

    const previousDistance = managed.trailDistance;
    managed.trailDistance = nextDistance;
    this.log({
      at: Date.now(),
      action: "trail",
      symbol: managed.symbol,
      positionId: managed.positionId,
      side: managed.side,
      sl: managed.trailStop,
      reason: `TS profit distance ${(previousDistance / managed.pip).toFixed(1)}p → ${(nextDistance / managed.pip).toFixed(1)}p (${why})`,
      ok: true,
    });
    // The distance change can move the stop closer to the best price. The
    // advanceVirtualStop ratchet guarantees the level itself never backs off.
    this.advanceStop(managed, "profit trail tighten", quote);
  }

  async manage(view: AccountView): Promise<void> {
    // Dry-run is strictly read-only. It must never create an SLTP, trail a
    // broker position, or close anything, even when .cache/KILL is present.
    if (!this.deps.live) return;
    if (this.killActive()) {
      await this.closeAll(view);
      return;
    }

    await this.syncPositions(view);
    for (const managed of [...this.managed.values()]) {
      const position = view.positions.find((entry) => entry.position_id === managed.positionId);
      if (!position) {
        // Snapshots can lag an open by a tick, and a rate-limited fetch can
        // briefly omit a position. Require two misses and a short grace period.
        managed.misses = (managed.misses ?? 0) + 1;
        if (Date.now() - managed.openedAt < 6_000 || managed.misses < 2) continue;
        await this.finalize(managed);
        continue;
      }
      managed.misses = 0;

      // A TS close remains mandatory after its trigger, even if the original
      // quote has since retraced or another broker mutation temporarily blocked it.
      if (managed.closeRequested && !managed.closing) {
        await this.closeFull(managed, managed.closeRequested);
        continue;
      }

      const quote = this.deps.ticks.get(managed.symbol);
      if (!quote) continue;

      const now = Date.now();
      const sltp = view.orders.find(
        (order) =>
          order.order_type === "sltp" &&
          order.position_id === managed.positionId &&
          order.state === "placed",
      );
      if (sltp?.order_id) {
        managed.slOrderId = sltp.order_id;
        const brokerSl = Number(sltp.stop_loss_price ?? 0);
        if (
          brokerSl > 0 &&
          (!(managed.emergencySl > 0) ||
            (managed.side === "buy" ? brokerSl > managed.emergencySl : brokerSl < managed.emergencySl))
        ) {
          managed.emergencySl = brokerSl;
        }
      } else if (
        !managed.closing &&
        now - managed.openedAt > 10_000 &&
        now - managed.lastStopEnsureAt >= this.deps.config.stopEnsureRetryMs
      ) {
        await this.ensureEmergencyStop(managed);
      }

      // ATR distance is refreshed once per trail timeframe close; virtual stop
      // advances on every favorable tick and never moves backwards
      const boundary = candleBoundary(this.deps.config.trailTimeframe, now);
      if (managed.lastAtrSyncAt < boundary) {
        managed.lastAtrSyncAt = boundary;
        await this.refreshTrailDistance(managed);
      }

      // ATR refresh can await REST. Read the quote again afterward so TS
      // decisions use the newest executable price, not the pre-await cache.
      const currentQuote = this.deps.ticks.get(managed.symbol);
      const quoteNow = Date.now();
      if (
        !currentQuote ||
        !isFreshQuote(currentQuote.timestamp, quoteNow, this.deps.config.maxQuoteAgeMs)
      ) {
        continue;
      }

      this.processTrailingQuote(managed, currentQuote, quoteNow);
      if (!managed.closing && managed.trailActivated) {
        await this.tightenEmergencyStop(managed, currentQuote);
      }
    }
  }

  /** Move broker emergency SL only in the protective direction after profit lock. */
  private async tightenEmergencyStop(managed: ManagedPosition, quote: Quote): Promise<void> {
    if (!managed.trailActivated || !managed.slOrderId || managed.closing || this.busy.has(managed.positionId)) {
      return;
    }
    const now = Date.now();
    if (now - (managed.lastBrokerStopMoveAt ?? 0) < this.deps.config.brokerStopUpdateMs) return;

    const minimumMarketGap = this.deps.config.minStopPips * managed.pip;
    const raw = managed.side === "buy"
      ? Math.min(managed.trailStop, quote.bid - minimumMarketGap)
      : Math.max(managed.trailStop, quote.ask + minimumMarketGap);
    const target = roundStopAway(raw, managed.digits, managed.side);
    const epsilon = this.deps.config.brokerStopMoveMinPips * managed.pip;
    if (!Number.isFinite(target) || !improved(managed.side, target, managed.emergencySl, epsilon)) return;
    if (managed.side === "buy" && target >= quote.bid) return;
    if (managed.side === "sell" && target <= quote.ask) return;

    this.busy.add(managed.positionId);
    managed.lastBrokerStopMoveAt = now;
    try {
      const result = await this.deps.tools.setSltp(managed.positionId, target, managed.digits);
      if (!result.ok) {
        this.log({
          at: Date.now(),
          action: "error",
          symbol: managed.symbol,
          positionId: managed.positionId,
          sl: target,
          reason: `broker SL tighten rejected: ${result.errorMessage ?? result.status}`,
          ok: false,
        });
        return;
      }
      managed.emergencySl = target;
      const order = result.data?.orders?.find((item) => item.order_type === "sltp");
      if (order?.order_id) managed.slOrderId = order.order_id;
      this.log({
        at: Date.now(),
        action: "protect",
        symbol: managed.symbol,
        positionId: managed.positionId,
        side: managed.side,
        sl: target,
        reason: "broker emergency SL tightened to protect profit",
        ok: true,
      });
      this.deps.tools.invalidateSnapshot();
    } catch (error) {
      this.log({
        at: Date.now(),
        action: "error",
        symbol: managed.symbol,
        positionId: managed.positionId,
        reason: `broker SL tighten error: ${error instanceof Error ? error.message : String(error)}`,
        ok: false,
      });
    } finally {
      this.busy.delete(managed.positionId);
    }
  }

  private triggerReason(managed: ManagedPosition, quote: Quote): string {
    const price = managed.side === "buy" ? quote.bid : quote.ask;
    return `TS VIRTUAL hit | bid/ask ${price} | trail ${(managed.trailDistance / managed.pip).toFixed(1)}p`;
  }

  private advanceStop(managed: ManagedPosition, why: string, quote?: Quote): void {
    if (managed.closing) return;
    let next = advanceVirtualStop(
      managed.side,
      managed.trailStop,
      managed.best,
      managed.trailDistance,
    );
    if (!Number.isFinite(next)) return;
    // A stop must never be pulled closer than the intended distance just
    // because of display rounding: floor a BUY stop, ceil a SELL stop.
    const factor = 10 ** managed.digits;
    const rounded =
      (managed.side === "buy" ? Math.floor(next * factor) : Math.ceil(next * factor)) /
      factor;
    const epsilon = managed.pip / 100;
    if (!improved(managed.side, rounded, managed.trailStop, epsilon)) return;
    const currentQuote = quote ?? this.deps.ticks.get(managed.symbol);
    if (
      !currentQuote ||
      !isFreshQuote(currentQuote.timestamp, Date.now(), this.deps.config.maxQuoteAgeMs)
    ) return;
    const spreadBuffer = Number.isFinite(currentQuote.spread) && currentQuote.spread > 0
      ? currentQuote.spread
      : 0;
    const minimumProfitDistance = profitLockCushion(
      spreadBuffer,
      this.deps.config.profitLockMinPips * managed.pip,
    );
    if (
      !canMoveTrailStop(
        managed.side,
        rounded,
        managed.entry,
        Boolean(managed.trailActivated),
        minimumProfitDistance,
      )
    ) {
      return;
    }

    const previousStop = managed.trailStop;
    managed.trailStop = rounded;
    this.trailing.push({
      at: Date.now(),
      symbol: managed.symbol,
      positionId: managed.positionId,
      sl: rounded,
    });
    if (this.trailing.length > 20) this.trailing.splice(0, this.trailing.length - 20);
    this.log({
      at: Date.now(),
      action: "trail",
      symbol: managed.symbol,
      positionId: managed.positionId,
      side: managed.side,
      sl: rounded,
      reason: `TS Updated ${previousStop.toFixed(managed.digits)} → ${managed.trailStop.toFixed(managed.digits)} · dist ${(managed.trailDistance / managed.pip).toFixed(1)}p (${why})`,
      ok: true,
    });
  }

  private async refreshTrailDistance(managed: ManagedPosition): Promise<void> {
    if (managed.closing) return;
    const result = await this.deps.marketTools.get_candles({
      symbol: managed.symbol,
      timeframe: this.deps.config.trailTimeframe,
      n: 60,
    });
    if (!result.ok) {
      this.log({
        at: Date.now(),
        action: "error",
        symbol: managed.symbol,
        positionId: managed.positionId,
        reason: `ATR refresh failed: ${result.message}`,
        ok: false,
      });
      return;
    }

    const closed = dropFormingCandle(
      result.data,
      timeframeMs(this.deps.config.trailTimeframe),
    );
    const atrValue = lastFinite(atr(closed, this.deps.config.trailAtrPeriod));
    if (atrValue === undefined || !(atrValue > 0)) return;

    const normalDistance = trailDistanceFromAtr(
      atrValue,
      this.deps.config.trailAtrFactor,
      this.deps.config.trailMinPips * managed.pip,
    );
    // Once profit is locked, ATR refreshes may only keep or tighten the
    // distance. They can never restore the wider pre-lock trailing distance.
    const quote = this.deps.ticks.get(managed.symbol);
    const distance = managed.trailActivated
      ? profitTrailDistanceFromAtr(
          managed.trailDistance,
          atrValue,
          this.deps.config.profitTrailAtrFactor,
          this.deps.config.profitTrailMinPips * managed.pip,
          quote?.spread ?? 0,
        )
      : normalDistance;
    managed.atr = atrValue;
    managed.trailDistance = distance;
    this.advanceStop(managed, `ATR ${atrValue.toFixed(managed.digits)}`);
  }

  private async ensureEmergencyStop(managed: ManagedPosition): Promise<void> {
    if (managed.closing || this.busy.has(managed.positionId)) return;
    this.busy.add(managed.positionId);
    managed.lastStopEnsureAt = Date.now();
    try {
      const result = await this.deps.tools.setSltp(
        managed.positionId,
        managed.emergencySl,
        managed.digits,
      );
      if (!result.ok) {
        managed.lastError = `${result.errorCode ?? ""} ${result.errorMessage ?? result.status}`.trim();
        this.log({
          at: Date.now(),
          action: "error",
          symbol: managed.symbol,
          positionId: managed.positionId,
          sl: managed.emergencySl,
          reason: `emergency SL missing: ${managed.lastError}`,
          ok: false,
        });
        return;
      }
      const created = result.data?.orders?.find((order) => order.order_type === "sltp");
      if (created?.order_id) managed.slOrderId = created.order_id;
      managed.lastError = undefined;
      this.log({
        at: Date.now(),
        action: "protect",
        symbol: managed.symbol,
        positionId: managed.positionId,
        side: managed.side,
        sl: managed.emergencySl,
        reason: "emergency SL created",
        ok: true,
      });
    } finally {
      this.busy.delete(managed.positionId);
    }
  }

  private async closeFull(managed: ManagedPosition, reason: string): Promise<void> {
    if (managed.closing) return;
    managed.closeRequested ??= reason;
    const now = Date.now();
    if (now < (managed.closeRetryAt ?? 0)) return;
    if (this.busy.has(managed.positionId)) {
      // Usually an emergency-SL update is still awaiting broker acknowledgement.
      // Queue the exit immediately after that mutation releases the position lock.
      managed.closeRetryAt = now + TS_CLOSE_BUSY_RETRY_MS;
      return;
    }
    managed.closing = true;
    this.busy.add(managed.positionId);
    try {
      const result = await this.deps.tools.close(managed.positionId);
      if (!result.ok) {
        const message = result.errorMessage ?? result.status;
        await this.handleCloseFailure(managed, reason, message, "rejected");
        return;
      }
      managed.closeAttempts = 0;
      managed.closeRetryAt = 0;
      managed.lastError = undefined;
      this.log({
        at: Date.now(),
        action: "close",
        symbol: managed.symbol,
        positionId: managed.positionId,
        side: managed.side,
        volume: managed.volume,
        price: managed.trailStop,
        reason,
        ok: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.handleCloseFailure(managed, reason, message, "error");
    } finally {
      this.busy.delete(managed.positionId);
    }
  }

  /**
   * Reconcile after every unsuccessful close, because a timeout/rejection may
   * arrive after the broker has already removed the position. If it is still
   * open, preserve the original TS trigger and retry with bounded backoff.
   */
  private async handleCloseFailure(
    managed: ManagedPosition,
    reason: string,
    message: string,
    kind: "rejected" | "error",
  ): Promise<void> {
    managed.closing = false;
    managed.closeRequested ??= reason;
    managed.lastError = message;

    let snapshotOpen: boolean | undefined;
    const needsReconciliation = kind === "error" ||
      indicatesPositionAlreadyClosed(message) ||
      /timeout|timed out|no transaction_event|no final operation status/i.test(message);
    if (needsReconciliation) {
      try {
        this.deps.tools.invalidateSnapshot();
        const fresh = await this.deps.tools.view(true);
        snapshotOpen = fresh.positions.some((position) => position.position_id === managed.positionId);
      } catch {
        // When reconciliation is unavailable, keep the close request and retry.
        // An ambiguous timeout must never be assumed to mean the trade is closed.
      }
    }

    if (snapshotOpen === false) {
      managed.closing = true;
      managed.closeRequested = undefined;
      managed.closeRetryAt = 0;
      managed.closeAttempts = 0;
      const goneNote = indicatesPositionAlreadyClosed(message)
        ? "broker also reported that the position is already gone"
        : "broker snapshot confirms the position is absent";
      this.log({
        at: Date.now(),
        action: "close",
        symbol: managed.symbol,
        positionId: managed.positionId,
        side: managed.side,
        volume: managed.volume,
        price: managed.trailStop,
        reason: "close reconciled: " + goneNote + " after API " + kind + " (" + message + "); P/L finalization pending",
        ok: true,
      });
      return;
    }

    managed.closeAttempts = (managed.closeAttempts ?? 0) + 1;
    const delay = closeRetryDelayMs(managed.closeAttempts, message);
    managed.closeRetryAt = Date.now() + delay;
    const movingPrice = /off quotes|requote|price changed|price moved|quote expired|price deviation|market price changed/i.test(message);
    this.log({
      at: Date.now(),
      action: "error",
      symbol: managed.symbol,
      positionId: managed.positionId,
      reason: "close " + kind + " (attempt " + managed.closeAttempts + "; retry in " + delay + "ms" +
        (movingPrice ? "; moving-price retry" : "") + "): " + message,
      ok: false,
    });
  }
  private async finalize(managed: ManagedPosition): Promise<void> {
    // Snapshots can lag a close. Tombstone the id so the dynamic sync cannot
    // re-adopt the same position while the broker row is still visible.
    this.recentlyFinalized.set(managed.positionId, Date.now());
    let realized = this.realized.get(managed.positionId);
    if (realized === undefined) {
      realized = await this.dealHistoryProfit(managed);
    }

    this.stats.trades += 1;
    this.stats.netProfit += realized;
    if (realized > 0.005) {
      this.stats.wins += 1;
      this.stats.consecutiveLosses = 0;
    } else if (realized < -0.005) {
      this.stats.losses += 1;
      this.stats.consecutiveLosses += 1;
    } else {
      this.stats.flats += 1;
      this.stats.consecutiveLosses = 0;
    }

    this.log({
      at: Date.now(),
      action: "close",
      symbol: managed.symbol,
      positionId: managed.positionId,
      side: managed.side,
      volume: managed.volume,
      reason: `net ${realized.toFixed(2)} USD`,
      ok: true,
    });
    this.managed.delete(managed.positionId);
    this.realized.delete(managed.positionId);
  }

  private async dealHistoryProfit(managed: ManagedPosition): Promise<number> {
    const from = new Date(managed.openedAt - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    try {
      const response = await this.deps.client.get<DealsHistoryResponse>(
        `/v1/history/accounts/${this.deps.accountId}/deals`,
        { query: { from, to, limit: 200 } },
      );
      let total = 0;
      for (const item of response.items) {
        const deal = "deal" in item ? item.deal : item;
        if (deal.position_id !== managed.positionId) continue;
        if (deal.type === "open") continue;
        total += dealProfit(deal);
      }
      return total;
    } catch {
      return 0;
    }
  }

  private trackDeals(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const event = raw as TransactionEvent;
    if (event.event_type !== "transaction_event") return;
    if (event.status !== "success") return;
    for (const deal of event.payload?.deals ?? []) {
      if (!deal.position_id) continue;
      if (deal.type === "open") continue;
      if (!this.managed.has(deal.position_id)) continue;
      this.realized.set(
        deal.position_id,
        (this.realized.get(deal.position_id) ?? 0) + dealProfit(deal),
      );
    }
  }

  private findOpenedPosition(
    result: OperationResult,
    symbol: string,
    beforeIds: Set<string>,
  ): Position | undefined {
    return result.data?.positions?.find(
      (position) =>
        position.state === "open" &&
        position.instrument === symbol &&
        !beforeIds.has(position.position_id),
    );
  }

  private log(entry: TradeLogEntry): void {
    this.tradeLog.push(entry);
    if (this.tradeLog.length > 200) this.tradeLog.splice(0, this.tradeLog.length - 200);
    const line = `${entry.action.padEnd(9)} ${entry.symbol ?? ""} ${entry.side ?? ""} ${
      entry.volume ? `${entry.volume} lot ` : ""
    }${entry.price ? `@ ${entry.price} ` : ""}${entry.sl ? `sl ${entry.sl} ` : ""}${entry.action === "open" && entry.positionId ? `#${entry.positionId} ` : ""}${entry.reason ?? ""}`.replace(/\s+/g, " ").trim();
    this.deps.log(line);
    const tone: AgentTone =
      entry.ok === false || entry.action === "error"
        ? "error"
        : entry.action === "close"
          ? "success"
          : entry.action === "skip"
            ? "warn"
            : "info";
    this.deps.journal?.record("trader", line, tone);
    try {
      fs.mkdirSync(path.join(this.deps.cacheDir, "trades"), { recursive: true });
      const key = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(
        path.join(this.deps.cacheDir, "trades", `${key}.jsonl`),
        `${JSON.stringify(entry)}\n`,
      );
    } catch {
      // audit trail is best effort
    }
  }
}
