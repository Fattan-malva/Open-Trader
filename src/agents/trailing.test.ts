import assert from "node:assert/strict";
import test from "node:test";

import { advanceVirtualStop, canMoveTrailStop, initialVirtualStop, isFreshQuote, profitLockCushion, profitLockStop, profitTrailDistanceFromAtr, updateBest, virtualStopLocksProfit, virtualStopHit } from "./trailing.js";

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be close to ${expected}`);
}

test("initial virtual stop is anchored near entry for BUY and SELL", () => {
  near(initialVirtualStop("buy", 1.1000, 0.0010), 1.0990);
  near(initialVirtualStop("sell", 1.1000, 0.0010), 1.1010);
});

test("virtual stop only ratchets toward profit", () => {
  near(advanceVirtualStop("buy", 1.0990, 1.1050, 0.0010), 1.1040);
  near(advanceVirtualStop("buy", 1.1040, 1.1030, 0.0010), 1.1040);
  near(advanceVirtualStop("sell", 1.1010, 1.0950, 0.0010), 1.0960);
  near(advanceVirtualStop("sell", 1.0960, 1.0970, 0.0010), 1.0960);
});

test("TS VIRT ratchets repeatedly as profit increases and stays put on retracement", () => {
  // BUY: each new best bid raises TS VIRT; a pullback cannot lower it.
  let buyBest = 1.1000;
  let buyStop = initialVirtualStop("buy", 1.1000, 0.0010);
  for (const bid of [1.1010, 1.1020, 1.1030, 1.1040]) {
    buyBest = updateBest("buy", buyBest, bid, bid + 0.0002);
    buyStop = advanceVirtualStop("buy", buyStop, buyBest, 0.0010);
  }
  near(buyBest, 1.1040);
  near(buyStop, 1.1030);
  const buyStopAtPeak = buyStop;
  buyBest = updateBest("buy", buyBest, 1.1020, 1.1022);
  buyStop = advanceVirtualStop("buy", buyStop, buyBest, 0.0010);
  near(buyStop, buyStopAtPeak);

  // SELL: each new best ask lowers TS VIRT; a rebound cannot raise it.
  let sellBest = 1.1000;
  let sellStop = initialVirtualStop("sell", 1.1000, 0.0010);
  for (const ask of [1.0990, 1.0980, 1.0970, 1.0960]) {
    sellBest = updateBest("sell", sellBest, ask - 0.0002, ask);
    sellStop = advanceVirtualStop("sell", sellStop, sellBest, 0.0010);
  }
  near(sellBest, 1.0960);
  near(sellStop, 1.0970);
  const sellStopAtPeak = sellStop;
  sellBest = updateBest("sell", sellBest, 1.0978, 1.0980);
  sellStop = advanceVirtualStop("sell", sellStop, sellBest, 0.0010);
  near(sellStop, sellStopAtPeak);
});

test("virtual stop counts as profit protection only beyond entry", () => {
  assert.equal(virtualStopLocksProfit("buy", 1.1001, 1.1000), true);
  assert.equal(virtualStopLocksProfit("buy", 1.1000, 1.1000), false);
  assert.equal(virtualStopLocksProfit("buy", 1.0999, 1.1000), false);
  assert.equal(virtualStopLocksProfit("sell", 1.0999, 1.1000), true);
  assert.equal(virtualStopLocksProfit("sell", 1.1000, 1.1000), false);
  assert.equal(virtualStopLocksProfit("sell", 1.1001, 1.1000), false);
});

test("the first TS update must already lock profit for BUY and SELL", () => {
  // BUY: a stop still below entry is not allowed as the first published update.
  assert.equal(canMoveTrailStop("buy", 1.0999, 1.1000, false), false);
  assert.equal(canMoveTrailStop("buy", 1.1001, 1.1000, false), true);

  // SELL: a stop still above entry is not allowed as the first published update.
  assert.equal(canMoveTrailStop("sell", 1.1001, 1.1000, false), false);
  assert.equal(canMoveTrailStop("sell", 1.0999, 1.1000, false), true);
});

test("first TS profit lock requires a buffer beyond entry", () => {
  assert.equal(canMoveTrailStop("buy", 1.1005, 1.1000, false, 0.0005), true);
  assert.equal(canMoveTrailStop("buy", 1.1004, 1.1000, false, 0.0005), false);
  assert.equal(canMoveTrailStop("sell", 1.0995, 1.1000, false, 0.0005), true);
  assert.equal(canMoveTrailStop("sell", 1.0996, 1.1000, false, 0.0005), false);
});

test("profit lock cushion covers the entry spread plus the minimum gain", () => {
  near(profitLockCushion(0.00012, 0.0001), 0.00022);
  near(profitLockCushion(0, 0.0001), 0.0001);
  near(profitLockCushion(0.0002, 0), 0.0002);
  near(profitLockCushion(Number.NaN, -1), 0);
});

test("immediate profit lock sits beyond entry by the cushion", () => {
  const cushion = profitLockCushion(0.00012, 0.0001);
  near(profitLockStop("buy", 1.1000, cushion), 1.10022);
  near(profitLockStop("sell", 1.1000, cushion), 1.09978);
  assert.ok(Number.isNaN(profitLockStop("buy", 1.1000, 0)));
  assert.ok(Number.isNaN(profitLockStop("sell", 0, cushion)));
});

test("tight post-lock trail chases a sustained move and never loosens", () => {
  let best = 1.1000;
  let stop = profitLockStop("buy", 1.1000, 0.0002);
  const distance = 0.0003;
  for (const bid of [1.1010, 1.1020, 1.1030, 1.1040]) {
    best = updateBest("buy", best, bid, bid + 0.0001);
    stop = advanceVirtualStop("buy", stop, best, distance);
  }
  near(stop, 1.1037);
  const peak = stop;
  best = updateBest("buy", best, 1.1025, 1.1026);
  near(advanceVirtualStop("buy", stop, best, distance), peak);
});

test("post-lock trail distance tightens and never widens", () => {
  const initialDistance = 0.0012;
  const tightened = profitTrailDistanceFromAtr(initialDistance, 0.001, 0.65, 0.00015, 0.0001);
  near(tightened, 0.00065);

  // If ATR or spread widens later, the active distance cannot widen again.
  const afterVolatility = profitTrailDistanceFromAtr(tightened, 0.003, 0.65, 0.00015, 0.0002);
  near(afterVolatility, tightened);
});

test("after profit is locked, the trail may tighten further but never loosen", () => {
  assert.equal(canMoveTrailStop("buy", 1.1020, 1.1000, true), true);
  assert.equal(canMoveTrailStop("sell", 1.0980, 1.1000, true), true);
});


test("TS price triggers require a fresh quote", () => {
  assert.equal(isFreshQuote(9_500, 10_000, 1_000), true);
  assert.equal(isFreshQuote(8_000, 10_000, 1_000), false);
  assert.equal(isFreshQuote(11_500, 10_000, 1_000), false);
});

test("virtual stop hit uses executable side of the quote", () => {
  assert.equal(virtualStopHit("buy", 1.1000, 1.0999, 1.1001), true);
  assert.equal(virtualStopHit("buy", 1.1000, 1.1001, 1.1003), false);
  assert.equal(virtualStopHit("sell", 1.1000, 1.1001, 1.1001), true);
  assert.equal(virtualStopHit("sell", 1.1000, 1.0998, 1.0999), false);
});
