import assert from "node:assert/strict";
import test from "node:test";

import type { Quote } from "../market/store.js";
import { MomentumTracker } from "./screener.js";

function quote(timestamp: number): Quote {
  return {
    symbol: "EURUSD",
    bid: 1.1,
    ask: 1.1001,
    mid: 1.10005,
    spread: 0.0001,
    spreadPct: (0.0001 / 1.10005) * 100,
    timestamp,
    ticks: 1,
    firstMid: 1.10005,
  };
}

test("shortlist activity counts recent ticks, not process-lifetime ticks", () => {
  const tracker = new MomentumTracker();
  tracker.observe(quote(1_000));
  tracker.observe(quote(1_400));
  tracker.observe(quote(2_100));

  assert.equal(tracker.ticksLastMinute("EURUSD", 2_500), 3);
  assert.equal(tracker.ticksLastMinute("EURUSD", 62_000), 1);
});
