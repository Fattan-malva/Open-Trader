import assert from "node:assert/strict";
import test from "node:test";

import { shouldOpenReentry, type EntryTriggerState } from "./reentry.js";

const previous: EntryTriggerState = {
  symbol: "EURUSD",
  side: "buy",
  candleTime: "2026-10-29T10:00:00.000Z",
  price: 1.1000,
  at: 1,
};

test("first signal is allowed", () => {
  assert.equal(shouldOpenReentry({
    side: "buy",
    candleTime: previous.candleTime,
    price: 1.1,
    atr: 0.001,
    stepAtr: 0.2,
    minimumStep: 0.0001,
  }), true);
});

test("same-candle BUY re-entry requires favourable price movement", () => {
  const common = {
    side: "buy" as const,
    candleTime: previous.candleTime,
    atr: 0.001,
    stepAtr: 0.2,
    minimumStep: 0.0001,
    previous,
  };
  assert.equal(shouldOpenReentry({ ...common, price: 1.10019 }), false);
  assert.equal(shouldOpenReentry({ ...common, price: 1.10020 }), true);
  assert.equal(shouldOpenReentry({ ...common, price: 1.0999 }), false);
});

test("same-candle SELL re-entry uses the inverse favourable direction", () => {
  const sellPrevious: EntryTriggerState = { ...previous, side: "sell", price: 1.1 };
  const common = {
    side: "sell" as const,
    candleTime: sellPrevious.candleTime,
    atr: 0.001,
    stepAtr: 0.2,
    minimumStep: 0.0001,
    previous: sellPrevious,
  };
  assert.equal(shouldOpenReentry({ ...common, price: 1.09981 }), false);
  assert.equal(shouldOpenReentry({ ...common, price: 1.0998 }), true);
  assert.equal(shouldOpenReentry({ ...common, price: 1.1002 }), false);
});

test("a new closed candle is a new trigger even if price is unchanged", () => {
  assert.equal(shouldOpenReentry({
    side: "buy",
    candleTime: "2026-10-29T10:01:00.000Z",
    price: previous.price,
    atr: 0.001,
    stepAtr: 0.2,
    minimumStep: 0.0001,
    previous,
  }), true);
});

test("minimum price step applies when ATR-based step is smaller", () => {
  assert.equal(shouldOpenReentry({
    side: "buy",
    candleTime: previous.candleTime,
    price: 1.10015,
    atr: 0.0001,
    stepAtr: 0.2,
    minimumStep: 0.0002,
    previous,
  }), false);
});
test("legacy entry watermark without candle time requires favourable price progress", () => {
  assert.equal(shouldOpenReentry({
    side: "buy",
    candleTime: "2026-10-29T10:01:00.000Z",
    price: 1.1001,
    atr: 0.001,
    stepAtr: 0.2,
    minimumStep: 0.0001,
    previous: { ...previous, candleTime: "" },
  }), false);
  assert.equal(shouldOpenReentry({
    side: "buy",
    candleTime: "2026-10-29T10:01:00.000Z",
    price: 1.1002,
    atr: 0.001,
    stepAtr: 0.2,
    minimumStep: 0.0001,
    previous: { ...previous, candleTime: "" },
  }), true);
});

