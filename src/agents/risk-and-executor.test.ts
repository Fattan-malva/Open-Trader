import assert from "node:assert/strict";
import test from "node:test";

import { computeLots } from "./risk-and-executor.js";

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
