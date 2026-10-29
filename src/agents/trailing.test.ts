import assert from "node:assert/strict";
import test from "node:test";

import { advanceVirtualStop, initialVirtualStop, virtualStopHit } from "./trailing.js";

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

test("virtual stop hit uses executable side of the quote", () => {
  assert.equal(virtualStopHit("buy", 1.1000, 1.0999, 1.1001), true);
  assert.equal(virtualStopHit("buy", 1.1000, 1.1001, 1.1003), false);
  assert.equal(virtualStopHit("sell", 1.1000, 1.1001, 1.1001), true);
  assert.equal(virtualStopHit("sell", 1.1000, 1.0998, 1.0999), false);
});
