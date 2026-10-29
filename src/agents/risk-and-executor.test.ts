import assert from "node:assert/strict";
import test from "node:test";

import { closeRetryDelayMs, computeLots, indicatesPositionAlreadyClosed, symbolEntryAllowed } from "./risk-and-executor.js";

const common = {
  equity: 1_000,
  riskPct: 0.5,
  slPips: 10,
  pipValuePerLot: 1,
  volumeMin: 0.01,
  volumeMax: 10,
  volumeStep: 0.01,
  maxLots: 1,
};

test("remaining aggregate budget caps the lot size below the per-trade risk target", () => {
  const sized = computeLots({ ...common, riskBudgetUsd: 0.47 });
  assert.equal(sized.lots, 0.04);
  assert.ok(sized.riskUsd <= 0.47);
  assert.ok(sized.riskUsd < (common.equity * common.riskPct) / 100);
});

test("rejects a minimum lot when it cannot fit the remaining aggregate budget", () => {
  const sized = computeLots({ ...common, riskBudgetUsd: 0.05 });
  assert.equal(sized.lots, 0);
  assert.match(sized.reason ?? "", /remaining aggregate budget/);
  assert.match(sized.reason ?? "", /minimum lot does not fit safely/);
});

test("retains normal per-trade sizing when no aggregate budget is supplied", () => {
  const sized = computeLots(common);
  assert.equal(sized.lots, 0.5);
  assert.equal(sized.riskUsd, 5);
});

test("price-movement close failures retry faster than general close failures", () => {
  assert.equal(closeRetryDelayMs(1, "off quotes"), 200);
  assert.equal(closeRetryDelayMs(2, "price changed"), 400);
  assert.equal(closeRetryDelayMs(1, "internal server error"), 250);
  assert.equal(closeRetryDelayMs(2, "internal server error"), 500);
});

test("close retry backoff is bounded and rate limits are respected", () => {
  assert.equal(closeRetryDelayMs(20, "price deviation"), 2_000);
  assert.equal(closeRetryDelayMs(20, "server internal error"), 5_000);
  assert.equal(closeRetryDelayMs(1, "HTTP 429 rate limit"), 1_500);
  assert.equal(closeRetryDelayMs(4, "too many requests"), 10_000);
});

test("detect broker responses indicating a position already closed", () => {
  assert.equal(indicatesPositionAlreadyClosed("position not found"), true);
  assert.equal(indicatesPositionAlreadyClosed("Position is already closed"), true);
  assert.equal(indicatesPositionAlreadyClosed("off quotes"), false);
  assert.equal(indicatesPositionAlreadyClosed("market closed"), false);
});

test("SCREAMING_SNAKE_CASE broker codes are recognised as already-closed", () => {
  assert.equal(indicatesPositionAlreadyClosed("REQUEST_POSITION_NOT_FOUND"), true);
  assert.equal(indicatesPositionAlreadyClosed("ERROR_POSITION_ALREADY_CLOSED"), true);
  assert.equal(indicatesPositionAlreadyClosed("POSITION_DOES_NOT_EXIST"), true);
  assert.equal(indicatesPositionAlreadyClosed("REQUEST_POSITION_NOT_FOUND some prose"), true);
  // Unrelated codes must not be swallowed.
  assert.equal(indicatesPositionAlreadyClosed("REQUEST_MARKET_CLOSED"), false);
  assert.equal(indicatesPositionAlreadyClosed("INSUFFICIENT_FUNDS"), false);
});

test("same-symbol stacking is rejected once the per-symbol cap is hit", () => {
  assert.equal(symbolEntryAllowed("XAUUSD", 0, 1, undefined, 0), undefined);
  assert.match(symbolEntryAllowed("XAUUSD", 1, 1, undefined, 0) ?? "", /already has 1 open/);
  assert.match(symbolEntryAllowed("XAUUSD", 2, 1, undefined, 0) ?? "", /already has 2 open/);
});

test("symbol cooldown blocks re-entry immediately after a close", () => {
  const now = Date.now();
  const cooldown = 5 * 60 * 1000;
  assert.match(symbolEntryAllowed("XAUUSD", 0, 1, now - 1000, cooldown) ?? "", /cooldown/);
});

test("symbol cooldown releases once the quiet period elapses", () => {
  const now = Date.now();
  const cooldown = 5 * 60 * 1000;
  assert.equal(symbolEntryAllowed("XAUUSD", 0, 1, now - cooldown - 1000, cooldown), undefined);
});

test("disabled cooldown never blocks re-entry", () => {
  const now = Date.now();
  assert.equal(symbolEntryAllowed("XAUUSD", 0, 5, now - 1000, 0), undefined);
});

test("small balance uses broker minimum lot when its real SL risk fits the remaining aggregate cap", () => {
  const sized = computeLots({
    ...common,
    equity: 10,
    riskPct: 0.1,
    // Example broker minimum lot risk: $0.10; 2% of $10 leaves $0.20.
    slPips: 10,
    pipValuePerLot: 1,
    volumeMin: 0.01,
    volumeStep: 0.01,
    riskBudgetUsd: 0.2,
  });
  assert.equal(sized.lots, 0.01);
  assert.ok(sized.riskUsd <= 0.2);
});

test("small balance still rejects minimum lot when actual stop risk exceeds the aggregate cap", () => {
  const sized = computeLots({
    ...common,
    equity: 10,
    riskPct: 0.1,
    slPips: 30,
    pipValuePerLot: 1,
    volumeMin: 0.01,
    volumeStep: 0.01,
    riskBudgetUsd: 0.2,
  });
  assert.equal(sized.lots, 0);
  assert.match(sized.reason ?? "", /broker minimum 0.01 lot risks 0.30 USD/);
  assert.match(sized.reason ?? "", /remaining aggregate budget 0.20 USD/);
});

test("minimum-lot fallback still obeys max lots per trade and broker volume maximum", () => {
  const sized = computeLots({
    ...common,
    equity: 10,
    riskPct: 0.1,
    slPips: 10,
    pipValuePerLot: 1,
    volumeMin: 0.02,
    volumeStep: 0.01,
    maxLots: 0.01,
    volumeMax: 1,
    riskBudgetUsd: 0.5,
  });
  assert.equal(sized.lots, 0);
  assert.match(sized.reason ?? "", /minimum lot does not fit safely/);
});
