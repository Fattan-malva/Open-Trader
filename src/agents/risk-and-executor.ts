import fs from "node:fs";
import path from "node:path";

import type { ExnessClient } from "../exness/client.js";
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
  initialVirtualStop,
  trailDistanceFromAtr,
  updateBest,
  virtualStopHit,
  type PositionSide,
} from "./trailing.js";

export interface ManagedPosition {
  positionId: string;
  symbol: string;
  side: PositionSide;
  entry: number;
  volume: number;
  step: number;
  digits: number;
  pip: number;

  /** distant broker-side stop; only the "program died" safety net */
  emergencySl: number;
  slOrderId?: string;

  /** program-side virtual trailing stop; never loosens */
  trailStop: number;
  trailDistance: number;
  best: number;
  atr: number;
  trailActivated?: boolean;
  /** Estimated USD value of a 1.0 price-unit move. */
  profitPerPriceUnitUsd?: number;
  /** Initial stop risk in USD for aggregate account-risk checks. */
  riskUsd?: number;
  lastBrokerStopMoveAt?: number;
  lastValuationAttemptAt?: number;

  openedAt: number;
  /** boundary of the last trail ATR refresh */
  lastAtrSyncAt: number;
  lastStopEnsureAt: number;
  lastError?: string;
  closing?: boolean;
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
}

export interface SizingResult {
  lots: number;
  riskUsd: number;
  reason?: string;
}

/**
 * Fixed-fractional sizing on the virtual risk equity. Always floors to the
 * volume step so a trade can never risk more than the configured percentage.
 */
export function computeLots(input: SizingInput): SizingResult {
  if (!(input.slPips > 0) || !(input.pipValuePerLot > 0) || !(input.volumeStep > 0)) {
    return { lots: 0, riskUsd: 0, reason: "invalid sizing inputs" };
  }
  const riskUsd = (input.equity * input.riskPct) / 100;
  const rawLots = riskUsd / (input.slPips * input.pipValuePerLot);
  let lots = roundVolumeDown(Math.min(rawLots, input.maxLots), input.volumeStep);
  if (lots > input.volumeMax) lots = roundVolumeDown(input.volumeMax, input.volumeStep);
  if (lots < input.volumeMin) {
    return {
      lots: 0,
      riskUsd,
      reason: `risk ${riskUsd.toFixed(2)} = ${rawLots.toFixed(3)} lot < volume_min ${input.volumeMin}`,
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
      const savedProfitPerPriceUnitUsd = Number(position.profitPerPriceUnitUsd);
      const wasAlreadyProtected = side === "buy" ? trailStop >= entry : trailStop <= entry;

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
        profitPerPriceUnitUsd: savedProfitPerPriceUnitUsd > 0 ? savedProfitPerPriceUnitUsd : undefined,
        riskUsd: savedRiskUsd > 0 ? savedRiskUsd : undefined,
        lastBrokerStopMoveAt: 0,
        lastValuationAttemptAt: 0,
        openedAt: Number(position.openedAt) || Date.now(),
        // Force a fresh trail ATR read on the first manage tick after a restart.
        lastAtrSyncAt: 0,
        lastStopEnsureAt: 0,
        score: Number(position.score) || 0,
        closing: false,
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
    return { ok: true };
  }

  // ---------------------------------------------------------------- open

  async open(
    signal: EntrySignal,
    view: AccountView,
  ): Promise<{ ok: boolean; reason?: string; managed?: ManagedPosition; result?: OperationResult }> {
    if (!this.deps.live) return { ok: false, reason: "dry-run: orders disabled" };
    const gate = this.tradingAllowed(view);
    if (!gate.ok) return { ok: false, reason: gate.reason };
    if (Date.now() > signal.expiresAt) return { ok: false, reason: "signal expired" };
    if (view.positions.length >= this.deps.config.maxOpenPositions) {
      return { ok: false, reason: `position cap ${this.deps.config.maxOpenPositions}` };
    }
    if (view.positions.some((position) => position.instrument === signal.symbol)) {
      return { ok: false, reason: `position already open for ${signal.symbol}` };
    }
    const managedIds = new Set(this.managed.keys());
    if (view.positions.some((position) => !managedIds.has(position.position_id))) {
      return { ok: false, reason: "unmanaged position present; total account risk cannot be verified" };
    }

    const quote = this.deps.ticks.get(signal.symbol);
    if (!quote || Date.now() - quote.timestamp > this.deps.config.maxQuoteAgeMs) {
      return { ok: false, reason: "quote stale" };
    }
    if (!spreadWithinLimit(signal.symbol, quote, this.deps.config)) {
      return { ok: false, reason: "spread too wide" };
    }
    // The signal's entry must still be reachable; otherwise the setup is gone.
    // Compare the price we would actually pay/receive (not the mid), so the
    // normal bid/ask spread never counts as a chase.
    const execution = signal.side === "buy" ? quote.ask : quote.bid;
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
    const emergencySl = roundStopAway(signal.emergencySl, digits, signal.side);
    const contractSize = parseNumber(conditions.contract_size, 100_000);
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
    const sizing = computeLots({
      equity: riskEquityUsd,
      riskPct: this.deps.config.riskPct,
      slPips: sizingSlPips,
      pipValuePerLot,
      volumeMin,
      volumeMax,
      volumeStep,
      maxLots: this.deps.config.maxLotsPerTrade,
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
    const currentManaged = [...this.managed.values()];
    if (currentManaged.some((position) => !(Number(position.riskUsd) > 0))) {
      return { ok: false, reason: "open position risk metadata unavailable; wait for it to close before adding risk" };
    }
    const openRiskUsd = currentManaged.reduce((sum, position) => sum + Number(position.riskUsd), 0);
    const maxOpenRiskUsd = riskEquityUsd * this.deps.config.maxOpenRiskPct / 100;
    if (openRiskUsd + plannedRiskUsd > maxOpenRiskUsd) {
      return {
        ok: false,
        reason: `open risk cap ${openRiskUsd.toFixed(2)} + ${plannedRiskUsd.toFixed(2)} > ${maxOpenRiskUsd.toFixed(2)} USD`,
      };
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
      volume: Number(position.volume),
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
      profitPerPriceUnitUsd: contractSize * quoteRate * Number(position.volume),
      riskUsd: Number(position.volume) * sizingSlPips * pipValuePerLot,
      lastBrokerStopMoveAt: 0,
      lastValuationAttemptAt: 0,
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
        `risk ${Number(managed.riskUsd ?? 0).toFixed(2)} USD · emergency ${(Math.abs(entry - emergencySl) / pip).toFixed(1)}p · ` +
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
   * Re-attach positions the agent opened but lost from its managed map (state
   * file removed, snapshot race after an open, or a restart mid-trade). The
   * trade log is the source of truth for entry/initial stop, so adoption never
   * touches positions that were not opened by this agent.
   */
  private adoptOrphans(view: AccountView): void {
    const known = new Set(this.managed.keys());
    const opened = new Map<string, TradeLogEntry>();
    for (const entry of this.tradeLog) {
      if (entry.action === "open" && entry.positionId && entry.ok !== false) {
        opened.set(entry.positionId, entry);
      }
    }
    for (const position of view.positions) {
      if (known.has(position.position_id)) continue;
      const entry = opened.get(position.position_id);
      if (!entry || !entry.symbol || !entry.price || !entry.sl) continue;
      if (entry.side !== position.direction) continue;

      const symbol = entry.symbol;
      const side: PositionSide = entry.side === "buy" ? "buy" : "sell";
      const sign = side === "buy" ? 1 : -1;
      const riskDistance = Math.abs(entry.price - entry.sl);
      if (!(riskDistance > 0)) continue;
      const sltp = view.orders.find(
        (order) =>
          order.order_type === "sltp" &&
          order.position_id === position.position_id &&
          order.state === "placed",
      );
      const brokerSl = Number(sltp?.stop_loss_price ?? 0);
      const priceText = String(position.open_price ?? entry.price);
      const digits = priceText.includes(".") ? priceText.split(".")[1]!.length : 5;
      const pip = pipSize(symbol, digits);
      // Old signals used a 1.5×ATR stop; reconstruct an approximate ATR so the
      // new 2×ATR trail is in the right ballpark. Broker SL, if already moved,
      // is kept as the virtual stop to preserve protection.
      const approxAtr = riskDistance / Math.max(1, this.deps.config.emergencySlAtrFactor);
      const trailDistance = trailDistanceFromAtr(
        approxAtr,
        this.deps.config.trailAtrFactor,
        this.deps.config.trailMinPips * pip,
      );
      const emergency = Number(entry.sl) || brokerSl || entry.price - sign * riskDistance;
      const initialStop = initialVirtualStop(side, entry.price, trailDistance);
      const trailStop = brokerSl > 0
        ? (side === "buy" ? Math.max(initialStop, brokerSl) : Math.min(initialStop, brokerSl))
        : initialStop;

      const managed: ManagedPosition = {
        positionId: position.position_id,
        symbol,
        side,
        entry: entry.price,
        volume: Number(position.volume),
        step: 0.01,
        digits,
        pip,
        emergencySl: emergency,
        slOrderId: sltp?.order_id,
        trailStop,
        trailDistance,
        best: entry.price,
        atr: approxAtr,
        trailActivated: side === "buy" ? trailStop >= entry.price : trailStop <= entry.price,
        riskUsd: Number(entry.riskUsd) > 0 ? Number(entry.riskUsd) : undefined,
        lastBrokerStopMoveAt: 0,
        lastValuationAttemptAt: 0,
        openedAt: Date.parse(position.create_time) || entry.at,
        lastAtrSyncAt: 0,
        lastStopEnsureAt: 0,
        score: 0,
      };
      this.managed.set(managed.positionId, managed);
      this.log({
        at: Date.now(),
        action: "open",
        symbol,
        positionId: managed.positionId,
        side,
        volume: managed.volume,
        price: managed.entry,
        sl: managed.emergencySl,
        reason: "adopted orphan position",
        ok: true,
      });
      this.deps.log(`adopt ${symbol} ${side} ${managed.volume} lot (${managed.positionId})`);
    }
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

  async manage(view: AccountView): Promise<void> {
    // Dry-run is strictly read-only. It must never create an SLTP, trail a
    // broker position, or close anything, even when .cache/KILL is present.
    if (!this.deps.live) return;
    if (this.killActive()) {
      await this.closeAll(view);
      return;
    }

    this.adoptOrphans(view);
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

      await this.ensureProfitValuation(managed);
      const closePrice = managed.side === "buy" ? quote.bid : quote.ask;
      const favorableMove = managed.side === "buy"
        ? closePrice - managed.entry
        : managed.entry - closePrice;
      const estimatedProfitUsd = Math.max(0, favorableMove) *
        Math.max(0, managed.profitPerPriceUnitUsd ?? 0);
      const activatedNow = !managed.trailActivated &&
        estimatedProfitUsd >= this.deps.config.trailProfitActivationUsd;
      if (activatedNow) {
        managed.trailActivated = true;
        this.log({
          at: now,
          action: "protect",
          symbol: managed.symbol,
          positionId: managed.positionId,
          side: managed.side,
          price: closePrice,
          reason: `profit-lock activated · gross estimated +${estimatedProfitUsd.toFixed(2)} USD`,
          ok: true,
        });
      }

      const previousBest = managed.best;
      managed.best = updateBest(managed.side, managed.best, quote.bid, quote.ask);
      if (managed.best !== previousBest || activatedNow) {
        this.advanceStop(managed, activatedNow
          ? `profit trigger +${estimatedProfitUsd.toFixed(2)} USD`
          : "best update");
      }

      if (!managed.closing && virtualStopHit(managed.side, managed.trailStop, quote.bid, quote.ask)) {
        await this.closeFull(managed, this.triggerReason(managed, quote));
      } else if (managed.trailActivated) {
        await this.tightenEmergencyStop(managed, quote);
      }
    }
  }

  /** Reconstruct valuation for positions restored from older state files. */
  private async ensureProfitValuation(managed: ManagedPosition): Promise<void> {
    if (Number(managed.profitPerPriceUnitUsd) > 0) return;
    const now = Date.now();
    if (now - (managed.lastValuationAttemptAt ?? 0) < 60_000) return;
    managed.lastValuationAttemptAt = now;
    try {
      const conditions = await this.deps.tools.conditions(managed.symbol);
      const contractSize = parseNumber(conditions.contract_size, 0);
      const quoteCurrency = (conditions.quote_currency ?? managed.symbol.slice(3)).toUpperCase();
      let quotes = new Map(this.deps.ticks.store.all().map((entry) => [entry.symbol, entry] as const));
      let quoteRate = quoteToUsdRate(quoteCurrency, quotes);
      if (quoteRate === undefined && quoteCurrency !== "USD") {
        await this.deps.ticks.ensure([`${quoteCurrency}USD`, `USD${quoteCurrency}`], 1500).catch(() => []);
        quotes = new Map(this.deps.ticks.store.all().map((entry) => [entry.symbol, entry] as const));
        quoteRate = quoteToUsdRate(quoteCurrency, quotes);
      }
      if (contractSize > 0 && quoteRate && quoteRate > 0 && managed.volume > 0) {
        managed.profitPerPriceUnitUsd = contractSize * quoteRate * managed.volume;
      }
    } catch {
      // Keep profit-lock trailing inactive until a trustworthy valuation is available.
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

  private advanceStop(managed: ManagedPosition, why: string): void {
    if (managed.closing || !managed.trailActivated) return;
    let next = advanceVirtualStop(
      managed.side,
      managed.trailStop,
      managed.best,
      managed.trailDistance,
    );
    const valuePerPriceUnit = Number(managed.profitPerPriceUnitUsd);
    if (Number.isFinite(valuePerPriceUnit) && valuePerPriceUnit > 0) {
      const lockDistance = this.deps.config.trailProfitLockUsd / valuePerPriceUnit;
      const lockStop = managed.side === "buy"
        ? managed.entry + lockDistance
        : managed.entry - lockDistance;
      next = managed.side === "buy" ? Math.max(next, lockStop) : Math.min(next, lockStop);
    }
    if (!Number.isFinite(next)) return;
    // A stop must never be pulled closer than the intended distance just
    // because of display rounding: floor a BUY stop, ceil a SELL stop.
    const factor = 10 ** managed.digits;
    const rounded =
      (managed.side === "buy" ? Math.floor(next * factor) : Math.ceil(next * factor)) /
      factor;
    const epsilon = managed.pip / 100;
    if (!improved(managed.side, rounded, managed.trailStop, epsilon)) return;

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
      reason: `${why} · trail ${(managed.trailDistance / managed.pip).toFixed(1)}p`,
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

    const distance = trailDistanceFromAtr(
      atrValue,
      this.deps.config.trailAtrFactor,
      this.deps.config.trailMinPips * managed.pip,
    );
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
    if (managed.closing || this.busy.has(managed.positionId)) return;
    managed.closing = true;
    this.busy.add(managed.positionId);
    try {
      const result = await this.deps.tools.close(managed.positionId);
      if (!result.ok) {
        managed.closing = false;
        managed.lastError = result.errorMessage ?? result.status;
        this.log({
          at: Date.now(),
          action: "error",
          symbol: managed.symbol,
          positionId: managed.positionId,
          reason: `close failed: ${managed.lastError}`,
          ok: false,
        });
        return;
      }
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
    } finally {
      this.busy.delete(managed.positionId);
    }
  }

  private async finalize(managed: ManagedPosition): Promise<void> {
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
    }${entry.sl ? `sl ${entry.sl} ` : ""}${entry.reason ?? ""}`.replace(/\s+/g, " ").trim();
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
