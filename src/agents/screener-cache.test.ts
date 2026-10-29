import assert from "node:assert/strict";
import test from "node:test";

import type { Quote } from "../market/store.js";
import type { Tools } from "../tools/index.js";
import type { TickHub } from "../runtime/hubs.js";
import { Screener, type ScreenerOptions } from "./screener.js";

const options: ScreenerOptions = {
  screenerTimeframe: "M1",
  trendTimeframe: "M5",
  shortlistSize: 20,
  maxCandidates: 20,
  minScore: 10,
  maxSpreadPips: 5,
  maxSpreadPct: 0.08,
  maxSpreadSpikeRatio: 2.5,
  maxSpreadTrailRatio: 0.4,
  minAtrPct: 0.0025,
  maxAtrPct: 1.8,
  pullbackDistanceAtr: 3,
  minTrendAtr: 0.003,
  rsiMin: 20,
  rsiMax: 80,
  breakoutLookback: 5,
  breakoutMinBodyAtr: 0.08,
  breakoutRsiFloor: 18,
  breakoutRsiCeiling: 82,
  maxQuoteAgeMs: 8_000,
  trailAtrFactor: 1.2,
  trailMinPips: 4,
};

function quote(): Quote {
  const now = Date.now();
  return {
    symbol: "EURUSD",
    bid: 1.1,
    ask: 1.1001,
    mid: 1.10005,
    spread: 0.0001,
    spreadPct: (0.0001 / 1.10005) * 100,
    timestamp: now,
    ticks: 1,
    firstMid: 1.10005,
  };
}

test("scan returns without waiting for rate-limited history and does not duplicate in-flight requests", async () => {
  let calls = 0;
  const tools = {
    get_candles: () => {
      calls += 1;
      return new Promise(() => {});
    },
  } as unknown as Tools;
  const ticks = { get: () => quote() } as unknown as TickHub;
  const screener = new Screener(tools, ticks, options);

  const started = Date.now();
  assert.deepEqual(await screener.scan(["EURUSD"]), []);
  assert.ok(Date.now() - started < 200, "scan should not wait for the candle API");
  assert.equal(calls, 2, "one history request for M5 and one for M1");
  assert.equal(screener.lastDiagnostics.cachePending, 1);

  assert.deepEqual(await screener.scan(["EURUSD"]), []);
  assert.equal(calls, 2, "the next fast scan should reuse the in-flight cache refresh");
  assert.equal(screener.lastDiagnostics.cachePending, 1);
});
