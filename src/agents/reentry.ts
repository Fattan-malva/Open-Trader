export type ReentrySide = "buy" | "sell";

export interface EntryTriggerState {
  symbol: string;
  side: ReentrySide;
  candleTime: string;
  price: number;
  at: number;
}

export interface ReentryTriggerInput {
  side: ReentrySide;
  candleTime: string;
  price: number;
  atr: number;
  stepAtr: number;
  minimumStep: number;
  previous?: EntryTriggerState;
}

/**
 * Permit one entry for a newly closed signal candle, or another entry after
 * price advances by a configured distance in the direction of the signal.
 * This is a trigger de-duplication rule, not a per-symbol position limit.
 */
export function shouldOpenReentry(input: ReentryTriggerInput): boolean {
  const { previous, side, candleTime, price, atr, stepAtr, minimumStep } = input;
  if (!previous) return true;
  if (!Number.isFinite(price) || price <= 0) return false;

  if (candleTime && candleTime !== previous.candleTime) return true;

  const step = Math.max(atr * stepAtr, minimumStep);
  if (!Number.isFinite(step) || step <= 0) return false;

  const favourableMove = side === "buy"
    ? price - previous.price
    : previous.price - price;
  return favourableMove >= step;
}
