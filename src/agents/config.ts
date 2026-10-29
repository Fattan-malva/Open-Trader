import { isTimeframe, type Timeframe } from "../market/timeframes.js";

/**
 * Deterministic agent settings. Every number is an explicit rule that can be
 * reviewed, backtested and tuned; nothing is learned at runtime.
 *
 * Flow: fast scan -> Screener (M5 trend + pullback/breakout) -> M1 confirmation
 * -> live quote/spread recheck -> risk sizing + broker emergency SL -> TS VIRT.
 */
export interface AgentConfig {
  scanIntervalMs: number;
  alignScanToCandle: boolean;
  manageIntervalMs: number;

  screenerTimeframe: Timeframe;
  trendTimeframe: Timeframe;
  confirmTimeframe: Timeframe;
  trailTimeframe: Timeframe;

  shortlistSize: number;
  maxCandidates: number;
  minScore: number;

  /** FX spread limit in pips. Other instruments use spread percent. */
  maxSpreadPips: number;
  maxSpreadPct: number;
  /** Category-specific non-FX spread caps, expressed as percent. */
  maxMetalSpreadPct?: number;
  maxCryptoSpreadPct?: number;
  maxEnergySpreadPct?: number;
  /** Reject when the current spread is this many times above its rolling median. */
  maxSpreadSpikeRatio: number;
  /** Reject when spread costs more than this fraction of the virtual trail distance. */
  maxSpreadTrailRatio: number;
  minAtrPct: number;
  maxAtrPct: number;
  /** Pullback candidates must sit within this many screener ATRs of EMA50. */
  pullbackDistanceAtr: number;
  /** Minimum trend EMA50/EMA200 separation, measured in trend ATRs. */
  minTrendAtr: number;
  rsiMin: number;
  rsiMax: number;
  breakoutLookback: number;
  breakoutMinBodyAtr: number;
  breakoutRsiFloor: number;
  breakoutRsiCeiling: number;

  maxOpenRiskPct: number;
  maxDailyLossPct: number;
  marginReservePct: number;

  virtualEquity: number;
  riskPct: number;
  maxLotsPerTrade: number;
  marginBuffer: number;

  brokerStopUpdateMs: number;
  brokerStopMoveMinPips: number;

  emergencySlAtrFactor: number;
  minStopPips: number;
  trailAtrFactor: number;
  trailAtrPeriod: number;
  trailMinPips: number;
  /** Tighter ATR distance used after TS first locks profit. */
  profitTrailAtrFactor: number;
  profitTrailMinPips: number;
  /** Minimum distance beyond entry before profit-lock is considered secured. */
  profitLockMinPips: number;
  /**
   * Peak profit, as a multiple of the planned stop distance (R), required
   * before the stop is pulled to break-even. 0 restores the old behaviour of
   * locking at the spread cushion alone, which turned every winner into a
   * near-scratch.
   */
  profitLockActivateR: number;
  /**
   * Adverse-side TS: cut a losing position before it reaches the broker
   * emergency stop. The cut distance is the tighter of
   * `lossCutRiskPct` of the planned stop distance and `lossCutAtrFactor` × ATR.
   * 0 disables the cut.
   */
  lossCutRiskPct: number;
  lossCutAtrFactor: number;
  lossCutMinPips: number;
  stopEnsureRetryMs: number;

  maxQuoteAgeMs: number;
  maxChaseAtr: number;

  /** Minimum favourable price advance before a same-candle re-entry. */
  reentryStepAtr: number;
  /** Minimum re-entry price step, even when ATR is unusually small. */
  reentryMinPips: number;
  /**
   * Maximum simultaneously open positions on one symbol. 1 prevents stacking
   * the same setup over and over (the 2026-10-29 book had 11 XAUUSD SELLs).
   */
  maxOpenPerSymbol: number;
  /** Quiet period after a symbol closes before it may be re-entered. */
  symbolCooldownMs: number;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function timeframe(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: Timeframe,
): Timeframe {
  const raw = env[key]?.trim().toUpperCase();
  return raw && isTimeframe(raw) ? raw : fallback;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  const defaults: AgentConfig = {
    scanIntervalMs: Math.max(1_000, num(env, "AGENT_SCAN_INTERVAL_MS", 2_000)),
    alignScanToCandle: bool(env, "AGENT_ALIGN_SCAN_TO_CANDLE", false),
    manageIntervalMs: Math.max(250, num(env, "AGENT_MANAGE_INTERVAL_MS", 1_000)),

    screenerTimeframe: timeframe(env, "AGENT_SCREENER_TF", "M1"),
    trendTimeframe: timeframe(env, "AGENT_TREND_TF", "M5"),
    confirmTimeframe: timeframe(env, "AGENT_CONFIRM_TF", "M1"),
    trailTimeframe: timeframe(env, "AGENT_TRAIL_TF", "M1"),

    // Wider ranking net plus a lower, but still positive, score gate finds more
    // opportunities without raising risk or bypassing hard execution filters.
    shortlistSize: Math.max(1, Math.trunc(num(env, "AGENT_SHORTLIST", 20))),
    maxCandidates: Math.max(1, Math.trunc(num(env, "AGENT_MAX_CANDIDATES", 20))),
    minScore: num(env, "AGENT_MIN_SCORE", 10),

    maxSpreadPips: num(env, "AGENT_MAX_SPREAD_PIPS", 5),
    maxSpreadPct: num(env, "AGENT_MAX_SPREAD_PCT", 0.08),
    maxMetalSpreadPct: num(env, "AGENT_MAX_METAL_SPREAD_PCT", 0.12),
    maxCryptoSpreadPct: num(env, "AGENT_MAX_CRYPTO_SPREAD_PCT", 0.2),
    maxEnergySpreadPct: num(env, "AGENT_MAX_ENERGY_SPREAD_PCT", 0.12),
    maxSpreadSpikeRatio: Math.max(1.1, num(env, "AGENT_MAX_SPREAD_SPIKE_RATIO", 2.5)),
    maxSpreadTrailRatio: num(env, "AGENT_MAX_SPREAD_TRAIL", 0.4),
    minAtrPct: num(env, "AGENT_MIN_ATR_PCT", 0.0025),
    maxAtrPct: num(env, "AGENT_MAX_ATR_PCT", 1.8),
    pullbackDistanceAtr: num(env, "AGENT_PULLBACK_ATR", 3),
    minTrendAtr: num(env, "AGENT_MIN_TREND_ATR", 0.003),
    rsiMin: num(env, "AGENT_RSI_MIN", 20),
    rsiMax: num(env, "AGENT_RSI_MAX", 80),
    breakoutLookback: Math.max(3, Math.trunc(num(env, "AGENT_BREAKOUT_LOOKBACK", 5))),
    breakoutMinBodyAtr: Math.max(0.05, num(env, "AGENT_BREAKOUT_BODY_ATR", 0.08)),
    breakoutRsiFloor: num(env, "AGENT_BREAKOUT_RSI_FLOOR", 18),
    breakoutRsiCeiling: num(env, "AGENT_BREAKOUT_RSI_CEILING", 82),

    virtualEquity: num(env, "EXNESS_VIRTUAL_EQUITY", 10_000),
    riskPct: Math.max(0.01, num(env, "AGENT_RISK_PCT", 0.1)),
    maxLotsPerTrade: num(env, "AGENT_MAX_LOTS", 0.5),
    marginBuffer: Math.max(1, num(env, "AGENT_MARGIN_BUFFER", 3)),
    maxOpenRiskPct: Math.max(0.1, num(env, "AGENT_MAX_OPEN_RISK_PCT", 2)),
    maxDailyLossPct: Math.max(0, num(env, "AGENT_MAX_DAILY_LOSS_PCT", 3)),
    marginReservePct: Math.min(90, Math.max(0, num(env, "AGENT_MARGIN_RESERVE_PCT", 25))),

    emergencySlAtrFactor: num(env, "AGENT_EMERGENCY_SL_ATR", 1.5),
    minStopPips: num(env, "AGENT_MIN_STOP_PIPS", 6),
    trailAtrFactor: num(env, "AGENT_TRAIL_ATR", 1.2),
    trailAtrPeriod: Math.max(2, Math.trunc(num(env, "AGENT_TRAIL_ATR_PERIOD", 14))),
    trailMinPips: num(env, "AGENT_TRAIL_MIN_PIPS", 4),
    
    profitLockMinPips: Math.max(0, num(env, "AGENT_PROFIT_LOCK_MIN_PIPS", 0.5)),
    profitLockActivateR: Math.max(0, num(env, "AGENT_PROFIT_LOCK_ACTIVATE_R", 0.5)),
    profitTrailAtrFactor: Math.max(0.05, num(env, "AGENT_PROFIT_TRAIL_ATR", 0.25)),
    profitTrailMinPips: Math.max(0.1, num(env, "AGENT_PROFIT_TRAIL_MIN_PIPS", 0.3)),
    lossCutRiskPct: Math.max(0, num(env, "AGENT_LOSS_CUT_RISK_PCT", 35)),
    lossCutAtrFactor: Math.max(0, num(env, "AGENT_LOSS_CUT_ATR", 0.8)),
    lossCutMinPips: Math.max(0.1, num(env, "AGENT_LOSS_CUT_MIN_PIPS", 2)),
    brokerStopUpdateMs: Math.max(1000, num(env, "AGENT_BROKER_STOP_UPDATE_MS", 10000)),
    brokerStopMoveMinPips: Math.max(0.1, num(env, "AGENT_BROKER_STOP_MOVE_MIN_PIPS", 2)),
    stopEnsureRetryMs: num(env, "AGENT_STOP_RETRY_MS", 15000),

    maxQuoteAgeMs: num(env, "AGENT_MAX_QUOTE_AGE_MS", 8000),
    maxChaseAtr: num(env, "AGENT_MAX_CHASE_ATR", 1.5),
    reentryStepAtr: Math.max(0.01, num(env, "AGENT_REENTRY_STEP_ATR", 0.2)),
    reentryMinPips: Math.max(0.1, num(env, "AGENT_REENTRY_MIN_PIPS", 1)),
    maxOpenPerSymbol: Math.max(1, Math.trunc(num(env, "AGENT_MAX_OPEN_PER_SYMBOL", 1))),
    symbolCooldownMs: Math.max(0, num(env, "AGENT_SYMBOL_COOLDOWN_MS", 5 * 60 * 1000)),
  };

  return { ...defaults, ...overrides };
}
