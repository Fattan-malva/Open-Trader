import assert from "node:assert/strict";
import test from "node:test";

import { apiInstruments, buildCatalog, categorize } from "./catalog.js";

test("instrument categories distinguish metals, energy, crypto and FX", () => {
  assert.equal(categorize("XAUUSD"), "metals");
  assert.equal(categorize("XAGUSD"), "metals");
  assert.equal(categorize("USOIL"), "energy");
  assert.equal(categorize("XNGUSD"), "energy");
  assert.equal(categorize("BTCUSD"), "crypto");
  assert.equal(categorize("SOLUSDT"), "crypto");
  assert.equal(categorize("EURUSD"), "fx");
});

test("API universe includes every supported tradable category and excludes stocks/indices", () => {
  const catalog = buildCatalog([
    "EURUSD", "XAUUSD", "USOIL", "BTCUSD", "US30", "AAPL",
  ], 1);
  assert.deepEqual(apiInstruments(catalog).sort(), [
    "BTCUSD", "EURUSD", "USOIL", "XAUUSD",
  ]);
});
