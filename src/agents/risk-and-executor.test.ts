import assert from "node:assert/strict";
import test from "node:test";

import { closeRetryDelayMs, computeLots, indicatesPositionAlreadyClosed } from "./risk-and-executor.js";

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
  assert.match(sized.reason ?? "", /remaining open-risk budget/);
  assert.match(sized.reason ?? "", /no safe minimum lot fits/);
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
