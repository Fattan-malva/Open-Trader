import { digitsFor } from "../exness/catalog.js";
import type { Candle, CandleBidAsk } from "../exness/types.js";

export interface NormalizedCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  askClose?: number;
  volume: number;
}

export function normalizeCandle(raw: Candle | CandleBidAsk): NormalizedCandle {
  if ("bid" in raw) {
    return {
      time: raw.time,
      open: raw.bid.open,
      high: raw.bid.high,
      low: raw.bid.low,
      close: raw.bid.close,
      askClose: raw.ask.close,
      volume: raw.volume,
    };
  }
  return { ...raw };
}

/**
 * One pip in price units. Exness quotes FX with 5 digits (3 for JPY pairs),
 * where 1 pip = 10 points. Metals/crypto/indices use their own digit counts.
 */
export function pipSize(symbol: string, digits = digitsFor(symbol)): number {
  return 10 ** -(Math.max(1, digits) - 1);
}

/**
 * The candle endpoint includes the still-forming candle. Signals must only use
 * candles that have actually closed, so drop the last bar while its window is
 * still in progress. If the last bar is already complete it is kept.
 */
export function dropFormingCandle(
  candles: NormalizedCandle[],
  timeframeMs: number,
  now = Date.now(),
): NormalizedCandle[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1]!;
  const start = Date.parse(last.time);
  if (Number.isFinite(start) && now < start + timeframeMs) return candles.slice(0, -1);
  return candles;
}
