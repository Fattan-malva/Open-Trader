import assert from "node:assert/strict";
import test from "node:test";

import type { Quote } from "../market/store.js";
import type { NormalizedCandle } from "../market/candles.js";
import { scoreCandidate, type ScreenerOptions } from "./screener.js";

function candles(
  count: number,
  closeAt: (index: number) => number,
  range: number,
): NormalizedCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    const previous = index > 0 ? closeAt(index - 1) : close;
    return {
      time: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
      open: previous,
      high: Math.max(previous, close) + range,
      low: Math.min(previous, close) - range,
      close,
      volume: 1,
    };
  });
}

function quote(symbol: string, timestamp: number, mid: number, spread: number): Quote {
  return {
    symbol,
    bid: mid - spread / 2,
    ask: mid + spread / 2,
    mid,
    spread,
    spreadPct: (spread / mid) * 100,
    timestamp,
    ticks: 20,
    firstMid: mid,
  };
}

const options: ScreenerOptions = {
  screenerTimeframe: "M1",
  trendTimeframe: "M15",
  shortlistSize: 20,
  maxCandidates: 16,
  minScore: 16,
  maxSpreadPips: 5,
  maxSpreadPct: 0.08,
  maxSpreadSpikeRatio: 2.5,
  maxSpreadTrailRatio: 0.4,
  minAtrPct: 0.0025,
  maxAtrPct: 1.8,
  pullbackDistanceAtr: 2.2,
  minTrendAtr: 0.006,
  rsiMin: 27,
  rsiMax: 73,
  breakoutLookback: 10,
  breakoutMinBodyAtr: 0.15,
  breakoutRsiFloor: 18,
  breakoutRsiCeiling: 82,
  maxQuoteAgeMs: 8_000,
  trailAtrFactor: 1.2,
  trailMinPips: 4,
};

test("screener can detect a trend-aligned closed-candle breakout", () => {
  const trend = candles(240, (i) => 1.04 + i * 0.00018, 0.00015);
  const screener = candles(
    80,
    (i) => 1.1 + (i % 2 === 0 ? 0.00002 : -0.00002),
    0.00004,
  );
  const previousClose = screener[screener.length - 2]!.close;
  screener[screener.length - 1] = {
    ...screener[screener.length - 1]!,
    open: previousClose,
    close: 1.101,
    high: 1.1011,
    low: previousClose - 0.00005,
  };

  const candidate = scoreCandidate({
    symbol: "EURUSD",
    screener,
    trend,
    quote: quote("EURUSD", Date.now(), 1.101, 0.0001),
    options,
  });

  assert.ok(candidate, "a clear breakout should pass the screener");
  assert.equal(candidate.setupType, "breakout");
  assert.equal(candidate.direction, "buy");
  assert.ok(candidate.reasons.some((reason) => reason.includes("breakout 10-bar range")));
});
