import assert from "node:assert/strict";
import test from "node:test";

import type { Quote } from "../market/store.js";
import type { NormalizedCandle } from "../market/candles.js";
import type { Candidate } from "./screener.js";
import { decideEntry, type EntryConfig } from "./entry.js";

const config: EntryConfig = {
  maxSpreadPips: 5,
  maxSpreadPct: 0.08,
  maxSpreadSpikeRatio: 2.5,
  maxSpreadTrailRatio: 0.4,
  maxQuoteAgeMs: 8_000,
  maxChaseAtr: 1.5,
  emergencySlAtrFactor: 1.5,
  minStopPips: 6,
  trailAtrFactor: 1.2,
  trailMinPips: 4,
  rsiMin: 27,
  rsiMax: 73,
  breakoutRsiFloor: 18,
  breakoutRsiCeiling: 82,
  pullbackDistanceAtr: 2.2,
  confirmTimeframe: "M1",
};

function quote(now: number, spread = 0.0001): Quote {
  return {
    symbol: "EURUSD",
    bid: 1.1002 - spread / 2,
    ask: 1.1002 + spread / 2,
    mid: 1.1002,
    spread,
    spreadPct: (spread / 1.1002) * 100,
    timestamp: now,
    ticks: 20,
    firstMid: 1.1002,
  };
}

function candidate(setupType: Candidate["setupType"], rsi: number): Candidate {
  const candle: NormalizedCandle = {
    time: new Date().toISOString(),
    open: 1.1,
    high: 1.1003,
    low: 1.0999,
    close: 1.1002,
    volume: 1,
  };
  return {
    symbol: "EURUSD",
    direction: "buy",
    setupType,
    score: 75,
    price: 1.1002,
    spreadPct: 0.009,
    spreadPips: 1,
    atr: 0.001,
    atrPct: 0.05,
    spreadRatio: 0.1,
    ema50: 1.1,
    trendEma50: 1.105,
    trendEma200: 1.1,
    rsi,
    trendAtr: 1,
    trendAtrValue: 0.01,
    distanceAtr: 2.4,
    reasons: [setupType],
    candles: [candle],
  };
}

test("breakout entry can accept trend momentum RSI above the pullback band", () => {
  const now = Date.now();
  const decision = decideEntry({
    candidate: candidate("breakout", 76),
    quote: quote(now),
    config,
    now,
  });
  assert.ok(decision.signal, decision.rejects.join("; "));
  assert.equal(decision.signal.setupType, "breakout");
  assert.ok(decision.signal.reasons.some((reason) => reason.includes("spread/trail")));
});

test("pullback entry still rejects RSI outside its dedicated band", () => {
  const now = Date.now();
  const decision = decideEntry({
    candidate: candidate("pullback", 76),
    quote: quote(now),
    config,
    now,
  });
  assert.equal(decision.signal, null);
  assert.ok(decision.rejects.some((reason) => reason.includes("pullback RSI")));
});

test("entry rejects stale quotes instead of using a stale spread/price", () => {
  const now = Date.now();
  const decision = decideEntry({
    candidate: candidate("breakout", 60),
    quote: quote(now - 20_000),
    config,
    now,
  });
  assert.equal(decision.signal, null);
  assert.ok(decision.rejects.some((reason) => reason.includes("quote")));
});
