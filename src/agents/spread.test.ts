import assert from "node:assert/strict";
import test from "node:test";

import type { Quote } from "../market/store.js";
import { assessSpread, observeSpread } from "./spread.js";

function quote(
  symbol: string,
  timestamp: number,
  spread: number,
  mid: number,
  spreadPct = (spread / mid) * 100,
): Quote {
  return {
    symbol,
    bid: mid - spread / 2,
    ask: mid + spread / 2,
    mid,
    spread,
    spreadPct,
    timestamp,
    ticks: 1,
    firstMid: mid,
  };
}

const limits = {
  maxSpreadPips: 5,
  maxSpreadPct: 0.08,
  maxSpreadSpikeRatio: 2.5,
};

test("FX spread spike is rejected against its own rolling median", () => {
  for (let i = 0; i < 10; i += 1) {
    observeSpread(quote("EURUSD", i * 1_000, 0.0001, 1.1));
  }

  const assessment = assessSpread("EURUSD", quote("EURUSD", 12_000, 0.0003, 1.1), limits);
  assert.equal(assessment.ok, false);
  assert.match(assessment.reason ?? "", /spread spike 3\.0x normal/);
  assert.equal(assessment.baseline, 1);
});

test("non-FX rolling baseline uses spread percentage, not raw price units", () => {
  for (let i = 0; i < 10; i += 1) {
    observeSpread(quote("XAUUSD", i * 1_000, 0.01, 100, 0.01));
  }

  const assessment = assessSpread("XAUUSD", quote("XAUUSD", 12_000, 0.03, 100, 0.03), limits);
  assert.equal(assessment.ok, false);
  assert.match(assessment.reason ?? "", /spread spike 3\.0x normal/);
  assert.equal(assessment.baseline, 0.01);
});

test("hard spread caps apply before a symbol history has warmed up", () => {
  const assessment = assessSpread("USDCHF", quote("USDCHF", 1_000, 0.0007, 0.9), limits);
  assert.equal(assessment.ok, false);
  assert.match(assessment.reason ?? "", /exceeds 5p cap/);
});

test("normal in-cap spread is accepted while a symbol has no baseline", () => {
  const assessment = assessSpread("AUDUSD", quote("AUDUSD", 1_000, 0.0001, 0.66), limits);
  assert.equal(assessment.ok, true);
  assert.equal(assessment.baseline, undefined);
});

test("metal-specific spread cap can be wider than the generic non-FX cap", () => {
  const assessment = assessSpread(
    "XPTUSD",
    quote("XPTUSD", 50_000, 0.1, 100, 0.1),
    { ...limits, maxMetalSpreadPct: 0.12 },
  );
  assert.equal(assessment.ok, true);
});
