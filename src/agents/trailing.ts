export type PositionSide = "buy" | "sell";

/**
 * New best price for a position, never moving backwards.
 * BUY tracks the highest bid; SELL tracks the lowest ask.
 */
export function updateBest(
  side: PositionSide,
  best: number,
  bid: number,
  ask: number,
): number {
  if (side === "buy") {
    if (!Number.isFinite(bid)) return best;
    return Number.isFinite(best) ? Math.max(best, bid) : bid;
  }
  if (!Number.isFinite(ask)) return best;
  return Number.isFinite(best) ? Math.min(best, ask) : ask;
}

/** ATR-based trail distance with an absolute minimum (e.g. 8 pips). */
export function trailDistanceFromAtr(atr: number, atrFactor: number, minDistance: number): number {
  const minimum = Number.isFinite(minDistance) && minDistance > 0 ? minDistance : 0;
  if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(atrFactor) || atrFactor <= 0) {
    return minimum;
  }
  return Math.max(atr * atrFactor, minimum);
}

/**
 * Initial virtual stop is anchored to the actual fill and a fast-ATR distance.
 * It must not inherit the wider broker emergency SL.
 */
export function initialVirtualStop(
  side: PositionSide,
  entry: number,
  trailDistance: number,
): number {
  if (!Number.isFinite(entry) || entry <= 0) return Number.NaN;
  const distance = Number.isFinite(trailDistance) && trailDistance > 0 ? trailDistance : 0;
  return side === "buy" ? entry - distance : entry + distance;
}

/** The stop implied by the recorded best price and current trail distance. */
export function virtualStopFor(
  side: PositionSide,
  best: number,
  trailDistance: number,
): number {
  if (!Number.isFinite(best) || !Number.isFinite(trailDistance) || trailDistance <= 0) {
    return Number.NaN;
  }
  return side === "buy" ? best - trailDistance : best + trailDistance;
}

/**
 * Advance a virtual stop - only moves in favorable direction, never backwards
 */
export function advanceVirtualStop(
  side: PositionSide,
  currentStop: number,
  best: number,
  trailDistance: number,
): number {
  const candidate = virtualStopFor(side, best, trailDistance);
  if (!Number.isFinite(candidate)) return currentStop;
  if (!Number.isFinite(currentStop)) return candidate;
  // Only ratchet in profit direction
  return side === "buy" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

/**
 * Gross-profit threshold for starting the profit lock.
 * Keep enough headroom above the configured lock so activation cannot
 * immediately place the virtual stop at/above the current executable price.
 */
export function profitLockActivationThreshold(lockUsd: number): number {
  const lock = Number.isFinite(lockUsd) && lockUsd > 0 ? lockUsd : 0;
  return lock + Math.max(0.02, lock * 0.5);
}

/**
 * Close when the market trades through the virtual stop
 */
export function virtualStopHit(
  side: PositionSide,
  stop: number,
  bid: number,
  ask: number,
): boolean {
  if (!Number.isFinite(stop)) return false;
  return side === "buy" ? bid <= stop : ask >= stop;
}
