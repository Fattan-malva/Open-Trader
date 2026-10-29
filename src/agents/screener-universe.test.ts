import assert from "node:assert/strict";
import test from "node:test";

import type { Quote } from "../market/store.js";
import { categorize } from "../exness/catalog.js";
import { selectFairShortlist, type RankedSymbol } from "./screener.js";

function ranked(symbol: string, prelim: number): RankedSymbol {
  const mid = symbol.startsWith("XAU") ? 2_300 : symbol.startsWith("BTC") ? 90_000 : 1.1;
  const spread = mid * 0.00001;
  const quote: Quote = {
    symbol,
    bid: mid - spread / 2,
    ask: mid + spread / 2,
    mid,
    spread,
    spreadPct: (spread / mid) * 100,
    timestamp: 1,
    ticks: 10,
    firstMid: mid,
  };
  return { quote, mom5: 0.1, prelim };
}

test("shortlist gives FX, metal, crypto and energy a share and keeps XAUUSD eligible", () => {
  const entries = [
    ranked("EURUSD", 100), ranked("GBPUSD", 99), ranked("USDJPY", 98),
    ranked("XAUUSD", 30), ranked("XAGUSD", 29), ranked("XPTUSD", 28),
    ranked("BTCUSD", 25), ranked("ETHUSD", 24), ranked("DOGEUSD", 23),
    ranked("USOIL", 20), ranked("UKOIL", 19),
  ];
  const selected = selectFairShortlist(entries, 8, 20_000);
  const categories = new Set(selected.map((entry) => categorize(entry.quote.symbol)));
  assert.ok(selected.some((entry) => entry.quote.symbol === "XAUUSD"));
  assert.ok(categories.has("fx"));
  assert.ok(categories.has("metals"));
  assert.ok(categories.has("crypto"));
  assert.ok(categories.has("energy"));
  assert.ok(selected.length <= 8);
});

test("rotation changes non-top scan slots so quiet symbols are not permanently starved", () => {
  const entries = [
    ranked("AAAUSD", 100), ranked("BBBUSD", 10), ranked("CCCUSD", 9),
    ranked("DDDUSD", 8), ranked("XAUUSD", 20), ranked("XAGUSD", 15),
    ranked("BTCUSD", 18), ranked("ETHUSD", 17), ranked("USOIL", 16),
  ];
  const first = selectFairShortlist(entries, 8, 0).map((entry) => entry.quote.symbol);
  const next = selectFairShortlist(entries, 8, 10_000).map((entry) => entry.quote.symbol);
  assert.ok(first.includes("BBBUSD") || first.includes("CCCUSD") || first.includes("DDDUSD"));
  assert.notDeepEqual(first, next);
});
