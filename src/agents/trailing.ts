export type PositionSide = "buy" | "sell";

/** A TS trigger must be based on a recent, non-future market quote. */
export function isFreshQuote(timestamp: number, now: number, maxAgeMs: number): boolean {
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(now) &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    now - timestamp <= maxAgeMs &&
    timestamp - now <= 1_000
  );
}

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
 * Desired post-lock distance: ATR/pip floor plus a spread cushion, capped at
 * the current distance so this distance itself can never widen after locking.
 */
export function profitTrailDistanceFromAtr(
  currentDistance: number,
  atr: number,
  atrFactor: number,
  minDistance: number,
  spread: number,
  spreadFactor = 1.1,
): number {
  const atrDistance = trailDistanceFromAtr(atr, atrFactor, minDistance);
  const spreadFloor = Number.isFinite(spread) && spread > 0 &&
    Number.isFinite(spreadFactor) && spreadFactor > 0
    ? spread * spreadFactor
    : 0;
  const desired = Math.max(atrDistance, spreadFloor);
  return Number.isFinite(currentDistance) && currentDistance > 0
    ? Math.min(currentDistance, desired)
    : desired;
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
 * Minimum profit (in price units) that must be secured before the first lock:
 * the entry spread is already paid, so break-even needs spread + minimum gain.
 * Closing at the lock still leaves a net gain after that spread.
 */
export function profitLockCushion(spread: number, minProfit: number): number {
  const spreadCost = Number.isFinite(spread) && spread > 0 ? spread : 0;
  const minimum = Number.isFinite(minProfit) && minProfit > 0 ? minProfit : 0;
  return spreadCost + minimum;
}

/** The virtual stop that locks the cushion beyond entry. */
export function profitLockStop(
  side: PositionSide,
  entry: number,
  cushion: number,
): number {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(cushion) || cushion <= 0) {
    return Number.NaN;
  }
  return side === "buy" ? entry + cushion : entry - cushion;
}

/**
 * True only when TS VIRT itself sits beyond entry in the profitable direction.
 * Uses executable-side price levels, not a fixed USD profit threshold.
 */
export function virtualStopLocksProfit(
  side: PositionSide,
  stop: number,
  entry: number,
): boolean {
  if (!Number.isFinite(stop) || !Number.isFinite(entry) || entry <= 0) return false;
  return side === "buy" ? stop > entry : stop < entry;
}

/**
 * Before the first profit-locking move, do not publish an intermediate trail
 * update that still leaves the stop on the loss side of entry. Once locked,
 * the ordinary monotonic ratchet may tighten the stop further.
 */
export function canMoveTrailStop(
  side: PositionSide,
  nextStop: number,
  entry: number,
  alreadyLocked: boolean,
  minimumProfitDistance = 0,
): boolean {
  if (alreadyLocked) return true;
  if (
    !Number.isFinite(nextStop) ||
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(minimumProfitDistance) ||
    minimumProfitDistance < 0
  ) return false;
  return side === "buy"
    ? nextStop >= entry + minimumProfitDistance
    : nextStop <= entry - minimumProfitDistance;
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
