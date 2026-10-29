import { categorize } from "../exness/catalog.js";
import { pipSize } from "../market/candles.js";
import type { Quote } from "../market/store.js";

export interface SpreadLimits {
  maxSpreadPips: number;
  maxSpreadPct: number;
  /** Reject sudden spread expansions compared with this symbol's recent median. */
  maxSpreadSpikeRatio?: number;
}

export interface SpreadAssessment {
  ok: boolean;
  reason?: string;
  value: number;
  unit: "pips" | "pct";
  baseline?: number;
  spikeRatio?: number;
}

interface SpreadSample {
  at: number;
  value: number;
}

const spreadHistory = new Map<string, SpreadSample[]>();
const SAMPLE_INTERVAL_MS = 1_000;
const HISTORY_WINDOW_MS = 15 * 60_000;
const MAX_SAMPLES = 180;
const MIN_BASELINE_SAMPLES = 8;

/** Spread converted to pips. Only meaningful for FX; used for FX limits. */
export function spreadPips(symbol: string, quote: Quote): number {
  const pip = pipSize(symbol);
  if (!(pip > 0) || !Number.isFinite(quote.spread)) return Number.POSITIVE_INFINITY;
  return quote.spread / pip;
}

/**
 * Remember one spread sample per symbol per second. The feed can emit many
 * ticks per second, so updating the last sample avoids unbounded memory while
 * retaining a useful rolling baseline for spread-spike detection.
 */
export function observeSpread(quote: Quote): void {
  if (
    !quote.symbol ||
    !Number.isFinite(quote.spread) ||
    quote.spread <= 0 ||
    !Number.isFinite(quote.timestamp)
  ) return;

  const series = spreadHistory.get(quote.symbol) ?? [];
  const last = series[series.length - 1];
  const sampleValue = categorize(quote.symbol) === "fx" ? quote.spread : quote.spreadPct;
  if (!Number.isFinite(sampleValue) || sampleValue <= 0) return;
  if (last && quote.timestamp >= last.at && quote.timestamp - last.at < SAMPLE_INTERVAL_MS) {
    last.at = quote.timestamp;
    last.value = sampleValue;
  } else {
    series.push({ at: quote.timestamp, value: sampleValue });
  }

  const cutoff = quote.timestamp - HISTORY_WINDOW_MS;
  while (series.length > 1 && series[0]!.at < cutoff) series.shift();
  while (series.length > MAX_SAMPLES) series.shift();
  spreadHistory.set(quote.symbol, series);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Evaluate the hard instrument-specific cap first, then compare the current
 * spread with that symbol's own rolling median. A cold symbol has no baseline
 * yet, so only the hard cap applies until enough observations arrive.
 */
export function assessSpread(
  symbol: string,
  quote: Quote,
  limits: SpreadLimits,
): SpreadAssessment {
  const fx = categorize(symbol) === "fx";
  const value = fx ? spreadPips(symbol, quote) : quote.spreadPct;
  const hardLimit = fx ? limits.maxSpreadPips : limits.maxSpreadPct;
  const unit = fx ? "pips" : "pct";
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(hardLimit) ||
    hardLimit <= 0 ||
    value > hardLimit
  ) {
    return {
      ok: false,
      reason: fx
        ? \`spread \${value.toFixed(2)}p exceeds \${hardLimit}p cap\`
        : \`spread \${(value * 100).toFixed(3)}% exceeds \${hardLimit}% cap\`,
      value,
      unit,
    };
  }

  const maxSpikeRatio = limits.maxSpreadSpikeRatio ?? 2.5;
  const series = spreadHistory.get(symbol) ?? [];
  const baselineValues = series
    .filter((sample) => sample.at < quote.timestamp && quote.timestamp - sample.at <= HISTORY_WINDOW_MS)
    .map((sample) => fx ? sample.value / pipSize(symbol) : sample.value);
  if (baselineValues.length >= MIN_BASELINE_SAMPLES) {
    const baseline = median(baselineValues);
    const spikeRatio = baseline > 0 ? value / baseline : 1;
    if (Number.isFinite(spikeRatio) && spikeRatio > maxSpikeRatio) {
      return {
        ok: false,
        reason: \`spread spike \${spikeRatio.toFixed(1)}x normal (limit \${maxSpikeRatio.toFixed(1)}x)\`,
        value,
        unit,
        baseline,
        spikeRatio,
      };
    }
    return { ok: true, value, unit, baseline, spikeRatio };
  }
  return { ok: true, value, unit };
}

/**
 * FX uses a pip limit. Metals, crypto and other non-FX instruments use a
 * percentage limit. Every category is also guarded by its symbol-specific
 * spread baseline after the baseline has warmed up.
 */
export function spreadWithinLimit(symbol: string, quote: Quote, limits: SpreadLimits): boolean {
  return assessSpread(symbol, quote, limits).ok;
}

export function spreadRejectionReason(
  symbol: string,
  quote: Quote,
  limits: SpreadLimits,
): string | undefined {
  const assessment = assessSpread(symbol, quote, limits);
  return assessment.ok ? undefined : assessment.reason;
}

export function spreadLabel(symbol: string, quote: Quote): string {
  if (categorize(symbol) === "fx") {
    const pips = spreadPips(symbol, quote);
    return \`\${pips.toFixed(1)}p\`;
  }
  return \`\${(quote.spreadPct * 100).toFixed(1)}bp\`;
}

/** 1 = tight, 0 = at the hard limit. Used to rank the prefilter shortlist. */
export function spreadQuality(symbol: string, quote: Quote, limits: SpreadLimits): number {
  if (categorize(symbol) === "fx") {
    const pips = spreadPips(symbol, quote);
    if (!Number.isFinite(pips) || limits.maxSpreadPips <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - pips / limits.maxSpreadPips));
  }
  if (!Number.isFinite(quote.spreadPct) || limits.maxSpreadPct <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - quote.spreadPct / limits.maxSpreadPct));
}
