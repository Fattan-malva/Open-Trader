import assert from "node:assert/strict";
import test from "node:test";

import { renderAgentContainers, type AgentStateFile } from "./panels.js";

test("ENTRY panel keeps full reject reasons and wraps them to continuation rows", () => {
  const message =
    "open ditolak XAUUSD: open risk cap 1.71 + 0.40 > 2.00 USD; remaining aggregate risk budget is too small for the broker minimum lot";
  const now = Date.now();
  const agent = {
    running: true,
    mode: "live",
    updatedAt: now,
    startedAt: now,
    universe: 85,
    nextScanAt: now + 2_000,
    timeframes: { screener: "M1", trend: "M5", confirm: "M1", trail: "M1" },
    screener: { at: now, durationMs: 100, pass: 0, candidates: [] },
    lastSignal: null,
    trailing: [],
    openPositions: [],
    stats: { trades: 0, wins: 0, losses: 0, flats: 0, netProfit: 0, consecutiveLosses: 0, winRate: 0 },
    dailyPnl: 0,
    tradeLog: [],
    activity: [{ at: now, agent: "entry", message, tone: "warn" }],
    executor: { managed: [], stats: {}, trailing: [], tradeLog: [] },
  } as unknown as AgentStateFile;

  // Narrow mode stacks panels vertically, so assertion text is not interleaved
  // with neighbouring panel columns on each wrapped row.
  const rendered = renderAgentContainers(agent, 90).replace(/\u001b\[[0-9;]*m/g, "");
  const normalized = rendered
    .replace(/[│╭╮╰]/g, " ")
    .replace(/\s*↳\s*/g, " ")
    .replace(/\s+/g, " ");
  assert.ok(normalized.includes(message), "the complete original entry message must be visible");
  assert.match(rendered, /↳ /, "wrapped continuation rows must have a marker");
  assert.doesNotMatch(rendered, /…/, "entry diagnostic text should not be ellipsis-truncated");
});


function renderedPanelHeights(rendered: string): number[] {
  const lines = rendered.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  const starts = lines
    .map((line, index) => line.startsWith("╭") ? index : -1)
    .filter((index) => index >= 0);
  return starts.map((start, index) => (starts[index + 1] ?? lines.length) - start);
}

test("all agent containers keep the tallest ENTRY height when later logs are shorter", () => {
  const now = Date.now();
  const base = {
    running: true,
    mode: "live",
    updatedAt: now,
    startedAt: now,
    universe: 85,
    nextScanAt: now + 2_000,
    timeframes: { screener: "M1", trend: "M5", confirm: "M1", trail: "M1" },
    screener: { at: now, durationMs: 100, pass: 0, candidates: [] },
    lastSignal: null,
    trailing: [],
    openPositions: [],
    stats: { trades: 0, wins: 0, losses: 0, flats: 0, netProfit: 0, consecutiveLosses: 0, winRate: 0 },
    dailyPnl: 0,
    tradeLog: [],
    executor: { managed: [], stats: {}, trailing: [], tradeLog: [] },
  };
  const scannerActivity = Array.from({ length: 24 }, (_, index) => ({
    at: now - (48 - index) * 1_000,
    agent: "screener",
    message: `scan PAIR${String(index + 1).padStart(2, "0")}`,
    tone: "info",
  }));
  const traderActivity = Array.from({ length: 24 }, (_, index) => ({
    at: now - (24 - index) * 1_000,
    agent: "trader",
    message: `adopt PAIR${String(index + 1).padStart(2, "0")}`,
    tone: "info",
  }));
  const longEntryState = {
    ...base,
    activity: [
      ...scannerActivity,
      ...traderActivity,
      {
        at: now,
        agent: "entry",
        message: "open ditolak XAUUSD: " +
          "price changed while checking minimum lot and aggregate risk budget ".repeat(10),
        tone: "warn",
      },
    ],
  } as unknown as AgentStateFile;
  const tallRendered = renderAgentContainers(longEntryState, 90);
  const tallHeights = renderedPanelHeights(tallRendered);
  assert.equal(tallHeights.length, 3);
  assert.ok(tallHeights[0]! > 6, "long ENTRY diagnostics should grow the cards");
  assert.deepEqual(tallHeights, [tallHeights[0], tallHeights[0], tallHeights[0]]);
  const plainTall = tallRendered.replace(/\u001b\[[0-9;]*m/g, "");
  const scannerLogCount = (plainTall.match(/SCAN PAIR\d+/g) ?? []).length;
  const traderLogCount = (plainTall.match(/ADOPT PAIR\d+/g) ?? []).length;
  assert.ok(scannerLogCount > 4, `SCREENER should use available space, got ${scannerLogCount} rows`);
  assert.ok(traderLogCount > 4, `TRADER should use available space, got ${traderLogCount} rows`);
  assert.ok(plainTall.includes("SCAN PAIR24"), "SCREENER should include its newest log row");
  assert.ok(plainTall.includes("ADOPT PAIR24"), "TRADER should include its newest log row");

  const shortLogState = {
    ...base,
    activity: [],
  } as unknown as AgentStateFile;
  const shortHeights = renderedPanelHeights(renderAgentContainers(shortLogState, 90));
  assert.deepEqual(
    shortHeights,
    [tallHeights[0], tallHeights[0], tallHeights[0]],
    "all cards should retain the high-water height after the log volume drops",
  );
});
