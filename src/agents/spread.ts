import { categorize } from "../exness/catalog.js";
import { pipSize } from "../market/candles.js";
import type { Quote } from "../market/store.js";

export interface SpreadLimits {
  maxSpreadPips: number;
  maxSpreadPct: number;
}

/** Spread converted to pips. Only meaningful for FX; used for FX limits. */
export function spreadPips(symbol: string, quote: Quote): number {
  const pip = pipSize(symbol);
  if (!(pip > 0) || !Number.isFinite(quote.spread)) return Number.POSITIVE_INFINITY;
  return quote.spread / pip;
}

/**
 * FX uses an absolute pip limit. Metals, indices, crypto and stocks use a
 * percentage limit, because "pips" means wildly different things across those
 * instruments. The screener also caps spread as a fraction of the trail.
 */
export function spreadWithinLimit(symbol: string, quote: Quote, limits: SpreadLimits): boolean {
  if (categorize(symbol) === "fx") {
    const pips = spreadPips(symbol, quote);
    return Number.isFinite(pips) && pips > 0 && pips <= limits.maxSpreadPips;
  }
  return (
    Number.isFinite(quote.spreadPct) &&
    quote.spreadPct > 0 &&
    quote.spreadPct <= limits.maxSpreadPct
  );
}

export function spreadLabel(symbol: string, quote: Quote): string {
  if (categorize(symbol) === "fx") {
    const pips = spreadPips(symbol, quote);
    return `${pips.toFixed(1)}p`;
  }
  return `${(quote.spreadPct * 100).toFixed(1)}bp`;
}

/** 1 = tight, 0 = at the limit. Used only to rank the prefilter shortlist. */
export function spreadQuality(symbol: string, quote: Quote, limits: SpreadLimits): number {
  if (categorize(symbol) === "fx") {
    const pips = spreadPips(symbol, quote);
    if (!Number.isFinite(pips) || limits.maxSpreadPips <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - pips / limits.maxSpreadPips));
  }
  if (!Number.isFinite(quote.spreadPct) || limits.maxSpreadPct <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - quote.spreadPct / limits.maxSpreadPct));
}
