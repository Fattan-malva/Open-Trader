import { digitsFor } from "../exness/catalog.js";
import { pipSize, type NormalizedCandle } from "../market/candles.js";
import type { Quote } from "../market/store.js";
import type { Timeframe } from "../market/timeframes.js";
import type { AgentConfig } from "./config.js";
import type { Candidate, Direction } from "./screener.js";
import { assessSpread, spreadLabel } from "./spread.js";

export interface EntryConfig {
  maxSpreadPips: number;
  maxSpreadPct: number;
  maxSpreadSpikeRatio: number;
  maxSpreadTrailRatio: number;
  maxQuoteAgeMs: number;
  maxChaseAtr: number;
  emergencySlAtrFactor: number;
  minStopPips: number;
  trailAtrFactor: number;
  trailMinPips: number;
  rsiMin: number;
  rsiMax: number;
  breakoutRsiFloor: number;
  breakoutRsiCeiling: number;
  pullbackDistanceAtr: number;
  confirmTimeframe: Timeframe;
}

export interface EntrySignal {
  symbol: string;
  side: Direction;
  setupType: Candidate["setupType"];
  /** live executable-side reference price at decision time */
  entry: number;
  /** Broker emergency stop, based on fast ATR and broker/spread minimums. */
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
 * Entry validates the selected setup against a fresh quote and the last closed
 * confirmation candle. Pullbacks retain RSI/EMA proximity checks; breakouts
 * are allowed to have momentum RSI readings but cannot enter at extreme
 * exhaustion or after chasing price too far.
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

  const spread = assessSpread(symbol, quote, config);
  if (!spread.ok) rejects.push(spread.reason ?? "spread rejected");
  const quoteAge = now - quote.timestamp;
  if (quoteAge > config.maxQuoteAgeMs || quoteAge < -1_000) {
    rejects.push(`quote ${Math.round(quoteAge)}ms old/future`);
  }

  const confirm = input.confirmCandles ?? candidate.candles;
  const last = confirm[confirm.length - 1];
  if (!last) {
    return { signal: null, rejects: [...rejects, `${config.confirmTimeframe} candles not ready`] };
  }

  const atrValue = candidate.atr;
  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    return { signal: null, rejects: [...rejects, "screener ATR not ready"] };
  }

  const trailDistance = Math.max(
    config.trailAtrFactor * atrValue,
    config.trailMinPips * pip,
  );
  const spreadRatio = trailDistance > 0
    ? quote.spread / trailDistance
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(spreadRatio) || spreadRatio > config.maxSpreadTrailRatio) {
    rejects.push(
      `spread cost ${(spreadRatio * 100).toFixed(0)}% of trail ` +
        `(max ${(config.maxSpreadTrailRatio * 100).toFixed(0)}%)`,
    );
  }

  const confirmed = side === "buy" ? last.close > last.open : last.close < last.open;
  if (!confirmed) {
    rejects.push(
      `${config.confirmTimeframe} close not ${side === "buy" ? "bullish" : "bearish"} ` +
        `(${last.open}→${last.close})`,
    );
  }

  if (candidate.setupType === "pullback") {
    if (candidate.rsi < config.rsiMin || candidate.rsi > config.rsiMax) {
      rejects.push(`pullback RSI ${candidate.rsi.toFixed(0)} outside ${config.rsiMin}-${config.rsiMax}`);
    }
    if (Math.abs(candidate.distanceAtr) > config.pullbackDistanceAtr) {
      rejects.push(`pullback price ${candidate.distanceAtr.toFixed(2)}×ATR from EMA50`);
    }
  } else if (
    (side === "buy" && candidate.rsi > config.breakoutRsiCeiling) ||
    (side === "sell" && candidate.rsi < config.breakoutRsiFloor)
  ) {
    rejects.push(`breakout momentum exhausted at RSI ${candidate.rsi.toFixed(0)}`);
  }

  // Mid is used for chase-distance so the normal bid/ask spread is not counted
  // twice; the executable ask/bid is still used for the actual entry price.
  const chaseAtr = Math.abs(quote.mid - last.close) / atrValue;
  if (chaseAtr > config.maxChaseAtr) {
    rejects.push(
      `chasing ${chaseAtr.toFixed(2)}×ATR from ${config.confirmTimeframe} close`,
    );
  }

  if (rejects.length > 0) return { signal: null, rejects };

  const entry = roundPrice(side === "buy" ? quote.ask : quote.bid, digits);
  const emergencyDistance = Math.max(
    config.emergencySlAtrFactor * atrValue,
    config.minStopPips * pip,
    quote.spread * 3,
  );
  const emergencySl = roundStop(entry - sign * emergencyDistance, digits, side);
  const slPips = Math.abs(entry - emergencySl) / pip;

  const reasons = [
    ...candidate.reasons,
    `${candidate.setupType} ${config.confirmTimeframe} ${side === "buy" ? "bullish" : "bearish"} close confirm`,
    `spread ${spreadLabel(symbol, quote)}`,
    `spread/trail ${(spreadRatio * 100).toFixed(0)}%`,
    `emergency SL ${slPips.toFixed(1)}p`,
    `trail ${(trailDistance / pip).toFixed(1)}p`,
  ];

  return {
    signal: {
      symbol,
      side,
      setupType: candidate.setupType,
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
    maxSpreadSpikeRatio: config.maxSpreadSpikeRatio,
    maxSpreadTrailRatio: config.maxSpreadTrailRatio,
    maxQuoteAgeMs: config.maxQuoteAgeMs,
    maxChaseAtr: config.maxChaseAtr,
    emergencySlAtrFactor: config.emergencySlAtrFactor,
    minStopPips: config.minStopPips,
    trailAtrFactor: config.trailAtrFactor,
    trailMinPips: config.trailMinPips,
    rsiMin: config.rsiMin,
    rsiMax: config.rsiMax,
    breakoutRsiFloor: config.breakoutRsiFloor,
    breakoutRsiCeiling: config.breakoutRsiCeiling,
    pullbackDistanceAtr: config.pullbackDistanceAtr,
    confirmTimeframe: config.confirmTimeframe,
  };
}
