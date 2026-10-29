import type { NormalizedCandle } from "./candles.js";

/** Simple moving average, NaN until the window is filled. */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) sum -= values[index - period]!;
    if (index >= period - 1) out[index] = sum / period;
  }
  return out;
}

/** Exponential moving average seeded with the first SMA window. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let index = 0; index < period; index += 1) sum += values[index]!;
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    out[index] = values[index]! * k + out[index - 1]! * (1 - k);
  }
  return out;
}

/** Wilder RSI. */
export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (values.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Wilder ATR. */
export function atr(candles: NormalizedCandle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(Number.NaN);
  if (candles.length <= period) return out;

  const trueRanges: number[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    if (index === 0) {
      trueRanges.push(candle.high - candle.low);
      continue;
    }
    const previousClose = candles[index - 1]!.close;
    trueRanges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      ),
    );
  }

  let sum = 0;
  for (let index = 0; index < period; index += 1) sum += trueRanges[index]!;
  out[period - 1] = sum / period;
  for (let index = period; index < candles.length; index += 1) {
    out[index] = (out[index - 1]! * (period - 1) + trueRanges[index]!) / period;
  }
  return out;
}

export function closes(candles: NormalizedCandle[]): number[] {
  return candles.map((candle) => candle.close);
}

export function lastFinite(values: number[]): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Average absolute move per candle in percent of price. */
export function atrPercent(candles: NormalizedCandle[], atrValue: number): number {
  const last = candles[candles.length - 1];
  if (!last || last.close === 0) return 0;
  return (atrValue / last.close) * 100;
}
