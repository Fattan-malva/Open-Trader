import assert from "node:assert/strict";
import test from "node:test";

import { advanceVirtualStop, canMoveTrailStop, initialVirtualStop, updateBest, virtualStopLocksProfit, virtualStopHit } from "./trailing.js";

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

test("after profit is locked, the trail may tighten further but never loosen", () => {
  assert.equal(canMoveTrailStop("buy", 1.1020, 1.1000, true), true);
  assert.equal(canMoveTrailStop("sell", 1.0980, 1.1000, true), true);
});

test("virtual stop hit uses executable side of the quote", () => {
  assert.equal(virtualStopHit("buy", 1.1000, 1.0999, 1.1001), true);
  assert.equal(virtualStopHit("buy", 1.1000, 1.1001, 1.1003), false);
  assert.equal(virtualStopHit("sell", 1.1000, 1.1001, 1.1001), true);
  assert.equal(virtualStopHit("sell", 1.1000, 1.0998, 1.0999), false);
});
