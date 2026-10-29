import { digitsFor } from "../exness/catalog.js";
import { pipSize, type NormalizedCandle } from "../market/candles.js";
import type { Quote } from "../market/store.js";
import type { Timeframe } from "../market/timeframes.js";
import type { AgentConfig } from "./config.js";
import type { Candidate, Direction } from "./screener.js";
import { spreadWithinLimit } from "./spread.js";

export interface EntryConfig {
  maxSpreadPips: number;
  maxSpreadPct: number;
  maxSpreadTrailRatio: number;
  maxQuoteAgeMs: number;
  maxChaseAtr: number;
  emergencySlAtrFactor: number;
  minStopPips: number;
  trailAtrFactor: number;
  trailMinPips: number;
  rsiMin: number;
  rsiMax: number;
  pullbackDistanceAtr: number;
  confirmTimeframe: Timeframe;
}

export interface EntrySignal {
  symbol: string;
  side: Direction;
  /** live reference price at decision time */
  entry: number;
  /** Broker emergency stop, based on fast ATR and the broker/spread minimums. */
  emergencySl: number;
  digits: number;
  pip: number;
  slPips: number;
  /** screener-timeframe ATR used for the virtual trail */
  atr: number;
  /** virtual trailing distance: max(ATR × factor, minimum pips) */
  trailDistance: number;
  score: number;
  reasons: string[];
  createdAt: number;
  expiresAt: number;
}

export interface EntryDecision {
  signal: EntrySignal | null;
  rejects: string[];
}

/**
 * Trend-following pullback entry.
 *
 * The screener has already checked the trend EMA50/EMA200, screener RSI,
 * distance to screener EMA50, ATR range and spread. Entry has one job: require
 * the last closed confirmation candle to agree with the trend direction, then
 * derive the broker emergency stop from fast ATR and broker/spread minimums.
 * There is deliberately no take-profit.
 */
export function decideEntry(input: {
  candidate: Candidate;
  quote: Quote;
  config: EntryConfig;
  /** closed confirmation candles; defaults to the screener candles */
  confirmCandles?: NormalizedCandle[];
  now?: number;
}): EntryDecision {
  const { candidate, quote, config } = input;
  const rejects: string[] = [];
  const now = input.now ?? Date.now();

  const symbol = candidate.symbol;
  const side = candidate.direction;
  const sign = side === "buy" ? 1 : -1;
  const digits = digitsFor(symbol);
  const pip = pipSize(symbol, digits);

  if (!spreadWithinLimit(symbol, quote, config)) {
    rejects.push("spread too wide");
  }
  if (now - quote.timestamp > config.maxQuoteAgeMs) {
    rejects.push(`quote ${now - quote.timestamp}ms old`);
  }

  const confirm = input.confirmCandles ?? candidate.candles;
  const last = confirm[confirm.length - 1];
  if (!last) {
    return { signal: null, rejects: [`${config.confirmTimeframe} candles not ready`] };
  }

  const atrValue = candidate.atr;
  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    return { signal: null, rejects: ["screener ATR not ready"] };
  }

  // Virtual trail is the normal exit. It stays tight and never loosens.
  const trailDistance = Math.max(
    config.trailAtrFactor * atrValue,
    config.trailMinPips * pip,
  );
  const spreadRatio =
    trailDistance > 0 ? quote.spread / trailDistance : Number.POSITIVE_INFINITY;
  if (spreadRatio > config.maxSpreadTrailRatio) {
    rejects.push(
      `spread cost ${(spreadRatio * 100).toFixed(0)}% of trail ` +
        `(max ${(config.maxSpreadTrailRatio * 100).toFixed(0)}%)`,
    );
  }

  // The confirmation candle must have CLOSED in the trend direction.
  const confirmed = side === "buy" ? last.close > last.open : last.close < last.open;
  if (!confirmed) {
    rejects.push(
      `${config.confirmTimeframe} close not ${side === "buy" ? "bullish" : "bearish"} ` +
        `(${last.open}→${last.close})`,
    );
  }

  if (candidate.rsi < config.rsiMin || candidate.rsi > config.rsiMax) {
    rejects.push(`RSI ${candidate.rsi.toFixed(0)} outside ${config.rsiMin}-${config.rsiMax}`);
  }
  if (Math.abs(candidate.distanceAtr) > config.pullbackDistanceAtr) {
    rejects.push(`price ${candidate.distanceAtr.toFixed(2)}×ATR from EMA50`);
  }

  const chaseAtr = Math.abs(quote.mid - last.close) / atrValue;
  if (chaseAtr > config.maxChaseAtr) {
    rejects.push(
      `chasing ${chaseAtr.toFixed(2)}×ATR from ${config.confirmTimeframe} close`,
    );
  }

  if (rejects.length > 0) return { signal: null, rejects };

  const entry = roundPrice(side === "buy" ? quote.ask : quote.bid, digits);

  // Keep the broker emergency stop closer to entry by using the fast
  // screener ATR, not the much larger trend-timeframe ATR. Broker minimum
  // distance and spread remain hard floors, and sizing uses this actual stop.
  const emergencyDistance = Math.max(
    config.emergencySlAtrFactor * atrValue,
    config.minStopPips * pip,
    quote.spread * 3,
  );
  const emergencySl = roundStop(entry - sign * emergencyDistance, digits, side);
  const slPips = Math.abs(entry - emergencySl) / pip;

  const reasons = [
    ...candidate.reasons,
    `${config.confirmTimeframe} ${side === "buy" ? "bullish" : "bearish"} close confirm`,
    `emergency SL ${slPips.toFixed(1)}p`,
    `trail ${(trailDistance / pip).toFixed(1)}p`,
  ];

  return {
    signal: {
      symbol,
      side,
      entry,
      emergencySl,
      digits,
      pip,
      slPips,
      atr: atrValue,
      trailDistance,
      score: candidate.score,
      reasons,
      createdAt: now,
      expiresAt: now + 15_000,
    },
    rejects: [],
  };
}

function roundPrice(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Round a stop away from the entry, so the minimum stop distance is never shaved. */
function roundStop(value: number, digits: number, side: Direction): number {
  const factor = 10 ** digits;
  return (side === "buy" ? Math.floor(value * factor) : Math.ceil(value * factor)) / factor;
}

export function entryConfigFrom(config: AgentConfig): EntryConfig {
  return {
    maxSpreadPips: config.maxSpreadPips,
    maxSpreadPct: config.maxSpreadPct,
    maxSpreadTrailRatio: config.maxSpreadTrailRatio,
    maxQuoteAgeMs: config.maxQuoteAgeMs,
    maxChaseAtr: config.maxChaseAtr,
    emergencySlAtrFactor: config.emergencySlAtrFactor,
    minStopPips: config.minStopPips,
    trailAtrFactor: config.trailAtrFactor,
    trailMinPips: config.trailMinPips,
    rsiMin: config.rsiMin,
    rsiMax: config.rsiMax,
    pullbackDistanceAtr: config.pullbackDistanceAtr,
    confirmTimeframe: config.confirmTimeframe,
  };
}
