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

  const rendered = renderAgentContainers(agent, 120).replace(/\u001b\[[0-9;]*m/g, "");
  const normalized = rendered.replace(/\s+/g, " ");
  assert.ok(normalized.includes(message), "the complete original entry message must be visible");
  assert.match(rendered, /↳ /, "wrapped continuation rows must have a marker");
  assert.doesNotMatch(rendered, /…/, "entry diagnostic text should not be ellipsis-truncated");
});
