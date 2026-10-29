import fs from "node:fs";
import path from "node:path";

import { EquityTracker } from "../../monitor/equity.js";
import { EventHub, TickHub, type HubOptions } from "../../runtime/hubs.js";
import { SnapshotCache } from "../../runtime/snapshot.js";
import { sleep } from "../../exness/client.js";
import { createAgentRuntime, type AgentRuntime } from "../../agents/runtime.js";
import { boolFlag, numberFlag, type ParsedArgs } from "../args.js";
import { createContext } from "../context.js";
import {
  clearScreen,
  hideCursor,
  moveHome,
  showCursor,
  style,
  terminalWidth,
} from "../render.js";
import {
  readAgentState,
  renderDashboard,
  renderDashboardFooter,
  type AgentStateFile,
  type DashboardState,
  type HistoryEntry,
} from "./panels.js";
import type { Deal } from "../../exness/types.js";

interface DealsHistoryResponse {
  items?: Array<{ deal?: Deal } | Deal>;
}

function collectHistory(items: DealsHistoryResponse["items"]): HistoryEntry[] {
  const byPosition = new Map<string, HistoryEntry>();
  for (const item of items ?? []) {
    const deal = (item as { deal?: Deal }).deal ?? (item as Deal);
    if (!deal || deal.type !== "close" || !deal.position_id) continue;
    const pnl =
      Number(deal.profit?.amount ?? 0) + Number(deal.commission ?? 0);
    const at = Date.parse(deal.create_time ?? "") || Date.now();
    const existing = byPosition.get(deal.position_id);
    if (existing) {
      existing.pnl += pnl;
      existing.at = Math.max(existing.at, at);
    } else {
      byPosition.set(deal.position_id, {
        at,
        symbol: deal.instrument ?? "?",
        side: deal.direction,
        volume: Number(deal.volume ?? 0),
        pnl,
      });
    }
  }
  return [...byPosition.values()].sort((a, b) => b.at - a.at).slice(0, 60);
}

export async function runDashboard(parsed: ParsedArgs): Promise<number> {
  const ctx = createContext(parsed);
  const info = await ctx.client.resolveAccessPoint();
  const snapshot = new SnapshotCache(ctx.client, ctx.config.accountId);
  const catalogData = await ctx.catalog.catalog();

  let view = await snapshot.get(true);

  const equity = new EquityTracker(ctx.config.cacheDir, view.currency);
  equity.loadToday();
  equity.record(view, true);

  const hubOptions: HubOptions = {
    accessPoint: info.accessPoint,
    identity: ctx.identity,
    accountId: ctx.config.accountId,
    cacheDir: ctx.config.cacheDir,
    verbose: ctx.verbose,
    logger: ctx.verbose ? (line) => console.error(style.dim(`[ws] ${line}`)) : undefined,
  };

  const ticks = new TickHub(hubOptions);
  const events = new EventHub(hubOptions);

  const killPath = path.join(ctx.config.cacheDir, "KILL");
  const isHalted = (): boolean => fs.existsSync(killPath);
  const setHalt = (): void => {
    try {
      fs.mkdirSync(ctx.config.cacheDir, { recursive: true });
      if (!fs.existsSync(killPath)) fs.writeFileSync(killPath, `${new Date().toISOString()}\n`);
    } catch {
      // ignore: the dashboard must stay usable even without write access
    }
  };
  const clearHalt = (): void => {
    try {
      if (fs.existsSync(killPath)) fs.rmSync(killPath);
    } catch {
      // ignore
    }
  };

  const startedAt = Date.now();
  let paused = false;
  let showOrders = view.orders.length > 0;
  let showEvents = true;
  let showAgent = true;
  let showCharts = true;
  let agentState: AgentStateFile | null = readAgentState(ctx.config.cacheDir);
  let agentReadAt = 0;
  let posScroll = 0;
  let history: HistoryEntry[] = [];

  const refreshAgent = (force = false): void => {
    if (!showAgent) return;
    const now = Date.now();
    if (!force && now - agentReadAt < 500) return;
    agentReadAt = now;
    agentState = readAgentState(ctx.config.cacheDir);
  };

  const buildState = (): DashboardState => ({
    view,
    ticks,
    events: events.events,
    equity,
    connection: {
      ticksState: ticks.state,
      eventsState: events.state,
      accessPoint: info.accessPoint,
    },
    startedAt,
    paused,
    showOrders,
    showEvents,
    showAgent,
    showCharts,
    halted: isHalted(),
    agent: agentState,
    posScroll,
    history,
  });

  const closeHubs = (): void => {
    ticks.close();
    events.close();
  };

  const loadHistory = async (): Promise<void> => {
    try {
      const to = new Date(Date.now() + 60_000).toISOString();
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const response = await ctx.client.get<DealsHistoryResponse>(
        `/v1/history/accounts/${ctx.config.accountId}/deals`,
        { query: { from, to, limit: 200 } },
      );
      history = collectHistory(response.items);
    } catch {
      // History is best-effort; keep the previous list on transient errors.
    }
  };

  if (boolFlag(parsed, "once") || !process.stdout.isTTY) {
    const watched =
      view.positions.length > 0
        ? view.positions.map((position) => position.instrument)
        : ["EURUSD", "XAUUSD"];
    events.start();
    ticks.start(watched);
    await ticks.ensure(watched, 5000);
    await loadHistory();
    await sleep(500);
    if (view.positions.length > 0) {
      view = await snapshot.get(true).catch(() => view);
      equity.record(view, true);
    }
    console.log(renderDashboard(buildState(), { width: 120, height: 72 }));
    console.log(style.dim(`  snapshot ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`));
    closeHubs();
    return 0;
  }

  const agent = createAgentRuntime({
    client: ctx.client,
    catalog: ctx.catalog,
    catalogData,
    accountId: ctx.config.accountId,
    cacheDir: ctx.config.cacheDir,
    snapshot,
    ticks,
    events,
    equity,
  });

  return new Promise<number>((resolve) => {
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isTTY && stdin.isRaw);
    const timers: NodeJS.Timeout[] = [];
    let forTimer: NodeJS.Timeout | undefined;
    let killArmed = false;
    let armTimer: NodeJS.Timeout | undefined;
    let finished = false;
    let scroll = 0;
    // mouse support
    let mouseEnabled = false;

    const cleanup = (): void => {
      for (const timer of timers) clearInterval(timer);
      if (forTimer) clearTimeout(forTimer);
      if (armTimer) clearTimeout(armTimer);
      stdin.removeListener("data", onKey);
      process.removeListener("SIGINT", onSigint);
      process.stdout.removeListener("resize", draw);
      agent.stop();
      closeHubs();
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(wasRaw);
        } catch {
          // ignore
        }
        stdin.pause();
      }
      if (mouseEnabled && process.stdout.isTTY) {
        try {
          process.stdout.write("\u001b[?1000l\u001b[?1002l\u001b[?1006l\u001b[?25h");
        } catch {
          // ignore
        }
      } else {
        showCursor();
      }
    };

    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      cleanup();
      process.stdout.write("\n");
      resolve(code);
    };

    const onSigint = (): void => finish(0);

    const scrollBy = (delta: number): void => {
      scroll = Math.max(0, scroll + delta);
      draw();
    };

    /** Split a raw chunk into single keys, keeping arrow/page escape codes intact. */
    const splitKeys = (text: string): string[] => {
      if (!text.includes("\u001b")) return [...text];
      const matches = text.match(/\u001b\[[0-9;]*[A-Za-z~]|\u001b\[<\d+;\d+;\d+[Mm]/g);
      return matches && matches.length > 0 ? matches : [text];
    };

    const onKey = (chunk: Buffer | string): void => {
      for (const key of splitKeys(chunk.toString("utf8"))) {
        // Mouse wheel support (SGR mode)
        if (key.startsWith("\u001b[<")) {
          // Try to parse button
          const m = key.match(/\u001b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (m) {
            const btn = parseInt(m[1]!);
            if (btn === 64) {
              if (view.positions.length > 0) posScroll = Math.max(0, posScroll - 2);
              draw();
              continue;
            }
            if (btn === 65) {
              if (view.positions.length > 0) {
                posScroll = Math.min(Math.max(0, view.positions.length - 1), posScroll + 2);
              }
              draw();
              continue;
            }
          }
        }
        if (key === "\u0003" || key === "q" || key === "Q") {
          finish(0);
          return;
        }
        if (key === "p" || key === "P") {
          paused = !paused;
          draw();
          if (!paused) void poll();
          continue;
        }
        if (key === "o" || key === "O") {
          showOrders = !showOrders;
          draw();
          continue;
        }
        if (key === "e" || key === "E") {
          showEvents = !showEvents;
          draw();
          continue;
        }
        if (key === "a" || key === "A") {
          showAgent = !showAgent;
          refreshAgent(true);
          draw();
          continue;
        }
        if (key === "c" || key === "C") {
          showCharts = !showCharts;
          draw();
          continue;
        }
        if (key === "r" || key === "R") {
          void snapshot
            .get(true)
            .then((next) => {
              view = next;
              equity.record(next, true);
              draw();
            })
            .catch(() => draw());
          continue;
        }
        if (key === "x" || key === "X") {
          killArmed = true;
          if (armTimer) clearTimeout(armTimer);
          armTimer = setTimeout(() => {
            killArmed = false;
            draw();
          }, 4000);
          draw();
          continue;
        }
        if (key === "n" || key === "N") {
          killArmed = false;
          draw();
          continue;
        }
        if ((key === "y" || key === "Y") && killArmed) {
          killArmed = false;
          if (armTimer) clearTimeout(armTimer);
          setHalt();
          draw();
          continue;
        }
        if (key === "u" || key === "U") {
          clearHalt();
          draw();
          continue;
        }
        if (key === "k" || key === "\u001b[A") {
          if (view.positions.length > 0) posScroll = Math.max(0, posScroll - 1);
          else scrollBy(-1);
          draw();
          continue;
        }
        if (key === "j" || key === "\u001b[B") {
          if (view.positions.length > 0) {
            posScroll = Math.min(Math.max(0, view.positions.length - 1), posScroll + 1);
          } else {
            scrollBy(1);
          }
          draw();
          continue;
        }
        if (key === "\u001b[5~") {
          scrollBy(-10);
          continue;
        }
        if (key === "\u001b[6~") {
          scrollBy(10);
          continue;
        }
        if (key === "g" || key === "\u001b[H") {
          scroll = 0;
          draw();
          continue;
        }
        if (key === "G" || key === "\u001b[F") {
          scroll = Number.MAX_SAFE_INTEGER;
          draw();
        }
      }
    };

    const draw = (): void => {
      if (finished) return;
      const width = terminalWidth();
      const rows = Math.max(12, Math.min(process.stdout.rows ?? 46, 200));
      refreshAgent();

      // Size the board to the terminal so the compact layout fits without a
      // vertical scroll. The viewport slice is only a safety net.
      const viewportRows = Math.max(6, rows - 1);
      const frame = renderDashboard(buildState(), { width, height: viewportRows });
      const lines = frame.split("\n");
      const maxScroll = Math.max(0, lines.length - viewportRows);
      scroll = Math.min(scroll, maxScroll);
      const visible = lines.slice(scroll, scroll + viewportRows);
      while (visible.length < viewportRows) visible.push("");
      const footer = renderDashboardFooter(buildState(), {
        width,
        killArmed,
        scroll: { offset: scroll, visible: viewportRows, total: lines.length },
      });

      moveHome();
      process.stdout.write(`${visible.join("\n")}\n${footer}\u001b[0J`);
    };

    const poll = async (): Promise<void> => {
      if (finished || paused) return;
      try {
        const next = await snapshot.get();
        view = next;
        equity.record(next);
        // Positions can be opened while the dashboard is running. Make sure
        // their instruments enter the tick feed even if they are not FX.
        if (next.positions.length > 0) {
          ticks.subscribe(next.positions.map((position) => position.instrument));
        }
      } catch {
        // Keep the previous view; transient REST errors are expected.
      }
    };

    stdin.on("data", onKey);
    process.on("SIGINT", onSigint);
    process.stdout.on("resize", draw);

    hideCursor();
    clearScreen();
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
    }
    // Enable mouse support
    if (process.stdout.isTTY) {
      try {
        process.stdout.write("\u001b[?1000h\u001b[?1002h\u001b[?1006h");
        mouseEnabled = true;
      } catch {
        mouseEnabled = false;
      }
    }

    timers.push(setInterval(() => void poll(), 2000));
    timers.push(setInterval(() => void loadHistory(), 15_000));
    timers.push(setInterval(draw, 150));

    const seconds = numberFlag(parsed, "for", 0);
    if (seconds > 0) {
      forTimer = setTimeout(() => finish(0), seconds * 1000);
    }

    void agent.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      agent.journal.record("screener", `agent start failed: ${message}`, "error");
    });
    void loadHistory();
    void poll();
    draw();
  });
}
