import { isTimeframe, type Timeframe } from "../market/timeframes.js";

/**
 * Deterministic agent settings. Every number is an explicit rule that can be
 * reviewed, backtested and tuned; nothing is learned at runtime.
 *
 * Flow: M1 close -> screener (M15 trend + M1 pullback) -> M1 confirmation
 * -> risk (1% sizing, broker emergency SL) -> program-side virtual trail.
 */
export interface AgentConfig {
  /** fallback cadence when alignment is disabled */
  scanIntervalMs: number;
  /** align each scan to the close of the screener timeframe */
  alignScanToCandle: boolean;
  /** how often open positions are managed (virtual trailing stop) */
  manageIntervalMs: number;

  /** candles used for the pullback, confirmation and trailing ATR */
  screenerTimeframe: Timeframe;
  /** higher timeframe used for the EMA50/EMA200 trend filter */
  trendTimeframe: Timeframe;
  /** candles used to confirm an entry */
  confirmTimeframe: Timeframe;
  /** candles used to refresh the trailing ATR */
  trailTimeframe: Timeframe;

  shortlistSize: number;
  maxCandidates: number;
  minScore: number;

  /**
   * FX spread limit in pips. Non-FX instruments use maxSpreadPct instead,
   * because a "pip" is not meaningful for crypto/indices/stocks.
   */
  maxSpreadPips: number;
  maxSpreadPct: number;
  /** reject when spread costs more than this fraction of the trail distance */
  maxSpreadTrailRatio: number;
  minAtrPct: number;
  maxAtrPct: number;
  /** price must sit within this many screener ATRs of EMA50 */
  pullbackDistanceAtr: number;
  /** minimum trend EMA50/EMA200 separation, measured in trend ATRs */
  minTrendAtr: number;
  rsiMin: number;
  rsiMax: number;

  /** risk capital used for sizing (demo balance is too large to size from) */
  virtualEquity: number;
  riskPct: number;
  maxLotsPerTrade: number;
  marginBuffer: number;

  /** broker-side emergency stop: 3 × trend-timeframe ATR */
  emergencySlAtrFactor: number;
  /** never place an emergency stop closer than this to the market */
  minStopPips: number;
  /** virtual trail: max(screener ATR × factor, minimum pips) */
  trailAtrFactor: number;
  trailAtrPeriod: number;
  trailMinPips: number;
  /** retry creating the emergency SLTP order while it is missing */
  stopEnsureRetryMs: number;

  maxQuoteAgeMs: number;
  maxChaseAtr: number;
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

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  const defaults: AgentConfig = {
    scanIntervalMs: Math.max(1_000, num(env, "AGENT_SCAN_INTERVAL_MS", 30_000)),
    alignScanToCandle: true,
    manageIntervalMs: Math.max(250, num(env, "AGENT_MANAGE_INTERVAL_MS", 1_000)),

    screenerTimeframe: timeframe(env, "AGENT_SCREENER_TF", "M1"),
    trendTimeframe: timeframe(env, "AGENT_TREND_TF", "M15"),
    confirmTimeframe: timeframe(env, "AGENT_CONFIRM_TF", "M1"),
    trailTimeframe: timeframe(env, "AGENT_TRAIL_TF", "M1"),

    // Rank a wide shortlist, then let the rules and the spread-cost guard
    // reject weak setups. M1 needs a wider net than M15 to find pullbacks.
    shortlistSize: Math.max(1, Math.trunc(num(env, "AGENT_SHORTLIST", 40))),
    maxCandidates: Math.max(1, Math.trunc(num(env, "AGENT_MAX_CANDIDATES", 40))),
    minScore: num(env, "AGENT_MIN_SCORE", 16),

    maxSpreadPips: num(env, "AGENT_MAX_SPREAD_PIPS", 5),
    maxSpreadPct: num(env, "AGENT_MAX_SPREAD_PCT", 0.08),
    maxSpreadTrailRatio: num(env, "AGENT_MAX_SPREAD_TRAIL", 0.4),
    minAtrPct: num(env, "AGENT_MIN_ATR_PCT", 0.0025),
    maxAtrPct: num(env, "AGENT_MAX_ATR_PCT", 1.8),
    pullbackDistanceAtr: num(env, "AGENT_PULLBACK_ATR", 1.8),
    minTrendAtr: num(env, "AGENT_MIN_TREND_ATR", 0.008),
    rsiMin: num(env, "AGENT_RSI_MIN", 30),
    rsiMax: num(env, "AGENT_RSI_MAX", 70),

    virtualEquity: num(env, "EXNESS_VIRTUAL_EQUITY", 10_000),
    riskPct: num(env, "AGENT_RISK_PCT", 1),
    maxLotsPerTrade: num(env, "AGENT_MAX_LOTS", 0.5),
    marginBuffer: 3,

    emergencySlAtrFactor: num(env, "AGENT_EMERGENCY_SL_ATR", 2.5),
    minStopPips: num(env, "AGENT_MIN_STOP_PIPS", 8),
    trailAtrFactor: num(env, "AGENT_TRAIL_ATR", 1.6),
    trailAtrPeriod: Math.max(2, Math.trunc(num(env, "AGENT_TRAIL_ATR_PERIOD", 14))),
    trailMinPips: num(env, "AGENT_TRAIL_MIN_PIPS", 6),
    stopEnsureRetryMs: num(env, "AGENT_STOP_RETRY_MS", 15000),

    maxQuoteAgeMs: num(env, "AGENT_MAX_QUOTE_AGE_MS", 8000),
    maxChaseAtr: num(env, "AGENT_MAX_CHASE_ATR", 2),
  };

  return { ...defaults, ...overrides };
}
