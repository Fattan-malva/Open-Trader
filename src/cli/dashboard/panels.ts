import fs from "node:fs";
import path from "node:path";

import type { Order, Position } from "../../exness/types.js";
import type { SocketState } from "../../exness/ws.js";
import { pipSize } from "../../market/candles.js";
import { digitsFor } from "../../exness/catalog.js";
import { changePct, formatNumber, type Quote } from "../../market/store.js";
import type { EquityTracker } from "../../monitor/equity.js";
import type { RuntimeEvent, TickHub } from "../../runtime/hubs.js";
import type { AccountView } from "../../runtime/snapshot.js";
import type { AgentActivity, AgentRole } from "../../agents/journal.js";
import { lineChart, pixelPnlChart, type ChartPoint } from "../chart.js";
import {
  clockTime,
  formatTime,
  pad,
  style,
  table,
  visibleLength,
} from "../render.js";

// ------------------------------------------------------------------- helpers

export function formatMoney(value: number, currency = "USD", digits = 2): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${currency ? ` ${currency}` : ""}`;
}

/** Short number for cramped KPI cards: 1.25M, 18.2k, 940. */
export function formatCompactMoney(value: number, currency = ""): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const suffix = currency ? ` ${currency}` : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B${suffix}`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M${suffix}`;
  if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}k${suffix}`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}k${suffix}`;
  return `${sign}${abs.toFixed(2)}${suffix}`;
}

export function formatCompactPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M%`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(0)}k%`;
  return `${value.toFixed(0)}%`;
}

export function formatSignedMoney(value: number, currency = "USD", digits = 2): string {
  const text = formatMoney(Math.abs(value), currency, digits);
  if (value > 0) return style.green(`+${text}`);
  if (value < 0) return style.red(`-${text}`);
  return style.dim(text);
}

export function formatPips(value: number, digits = 1): string {
  const text = `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toFixed(digits)}`;
  if (value > 0) return style.green(text);
  if (value < 0) return style.red(text);
  return style.dim(text);
}

export function formatSignedPct(value: number, digits = 2): string {
  const text = `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toFixed(digits)}%`;
  if (value > 0) return style.green(text);
  if (value < 0) return style.red(text);
  return style.dim(text);
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function section(title: string, width: number): string {
  const fill = Math.max(0, width - visibleLength(title) - 5);
  return `${style.dim("── ")}${style.bold(title)} ${style.dim("─".repeat(fill))}`;
}

export type PanelTone = "cyan" | "green" | "yellow" | "magenta" | "blue" | "gray";

const ANSI_AT_START = /^\u001b\[[0-9;]*m/;

function paintTone(tone: PanelTone, text: string): string {
  return style[tone](text);
}

/** ANSI-aware cut: keeps escape codes intact and reserves one column for "…". */
function cutAnsi(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  let out = "";
  let count = 0;
  let index = 0;
  let sawAnsi = false;
  while (index < text.length && count < width - 1) {
    const match = text.slice(index).match(ANSI_AT_START);
    if (match) {
      out += match[0];
      sawAnsi = true;
      index += match[0].length;
      continue;
    }
    out += text[index];
    count += 1;
    index += 1;
  }
  return `${out}${sawAnsi ? "\u001b[0m" : ""}…`;
}

function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = visibleLength(text) > width ? cutAnsi(text, width) : text;
  return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
}

function spreadLine(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

/** A rounded container with a coloured border and an inset content row. */
export function panel(
  title: string,
  lines: string[],
  width: number,
  tone: PanelTone = "gray",
  flush = false,
): string {
  const total = Math.max(16, width);
  const border = (text: string): string => paintTone(tone, text);
  const rawLabel = ` ${title} `;
  const label = visibleLength(rawLabel) > total - 2 ? cutAnsi(rawLabel, total - 2) : rawLabel;
  const fill = Math.max(0, total - 2 - visibleLength(label));
  const inner = Math.max(1, total - 4);
  const content = lines.length > 0 ? lines : [""];

  return [
    `${border("╭")}${border(label)}${border("─".repeat(fill))}${border("╮")}`,
    ...content.map((line) =>
      flush
        ? `${border("│")}${fitLine(line, total - 2)}${border("│")}`
        : `${border("│")} ${fitLine(line, inner)} ${border("│")}`,
    ),
    `${border("╰")}${border("─".repeat(total - 2))}${border("╯")}`,
  ].join("\n");
}

/** Compose already-rendered panels into an equal-height row. */
export function row(panels: string[], gap = " "): string {
  if (panels.length === 0) return "";
  const blocks = panels.map((entry) => entry.split("\n"));
  const widths = blocks.map((block) =>
    Math.max(...block.map((line) => visibleLength(line))),
  );
  const height = Math.max(...blocks.map((block) => block.length));
  const out: string[] = [];
  for (let line = 0; line < height; line += 1) {
    out.push(
      blocks
        .map((block, index) => block[line] ?? " ".repeat(widths[index] ?? 0))
        .join(gap),
    );
  }
  return out.join("\n");
}

function splitWidths(total: number, parts: number, gap = 1): number[] {
  const available = total - gap * (parts - 1);
  const base = Math.floor(available / parts);
  const remainder = available - base * parts;
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

function drawdownPoints(equity: EquityTracker): ChartPoint[] {
  let peak = Number.NEGATIVE_INFINITY;
  return equity.samples.map((sample) => {
    if (sample.equity > peak) peak = sample.equity;
    return { t: sample.t, value: sample.equity - peak };
  });
}

function dot(state: SocketState): string {
  if (state === "open") return style.green("●");
  if (state === "closed") return style.red("●");
  return style.yellow("○");
}

function sideLabel(direction: string | undefined): string {
  if (direction === "buy") return style.green("BUY ");
  if (direction === "sell") return style.red("SELL");
  return style.dim("—");
}

// --------------------------------------------------------------- positions

export function positionPips(position: Position, quote: Quote | undefined): number | null {
  const open = Number(position.open_price);
  if (!Number.isFinite(open) || open === 0) return null;
  const price = position.direction === "buy" ? quote?.bid : quote?.ask;
  if (!price) return null;
  const diff = position.direction === "buy" ? price - open : open - price;
  return diff / pipSize(position.instrument, digitsFor(position.instrument));
}

function slPrice(position: Position, view: AccountView): number | null {
  const order = view.orders.find(
    (entry) => entry.order_type === "sltp" && entry.position_id === position.position_id,
  );
  const value = Number(order?.stop_loss_price ?? position.stop_loss_price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

interface InstrumentMeta {
  contractSize: number;
  quoteCurrency: string;
}

const META_CACHE = new Map<string, InstrumentMeta>();

/** Contract size + quote currency from the cached instrument conditions. */
function instrumentMeta(symbol: string): InstrumentMeta {
  const hit = META_CACHE.get(symbol);
  if (hit) return hit;
  let contractSize = 100_000;
  let quoteCurrency = symbol.slice(3);
  try {
    const file = path.join(process.cwd(), ".cache", "conditions", `${symbol}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      conditions?: { contract_size?: string; quote_currency?: string };
    };
    const size = Number(raw.conditions?.contract_size);
    if (Number.isFinite(size) && size > 0) contractSize = size;
    if (raw.conditions?.quote_currency) quoteCurrency = raw.conditions.quote_currency;
  } catch {
    // Fall back to FX defaults when the condition file is not cached yet.
  }
  const meta = { contractSize, quoteCurrency };
  META_CACHE.set(symbol, meta);
  return meta;
}

/** Convert an amount expressed in `currency` into USD using live quotes. */
function toUsd(currency: string, ticks: TickHub): number {
  if (currency === "USD") return 1;
  const direct = ticks.get(`${currency}USD`);
  if (direct && direct.bid > 0) return direct.bid;
  const inverse = ticks.get(`USD${currency}`);
  if (inverse && inverse.ask > 0) return 1 / inverse.ask;
  for (const pivot of ["JPY", "CHF", "EUR", "GBP", "AUD", "NZD", "CAD"]) {
    if (pivot === currency) continue;
    const a = ticks.get(`${currency}${pivot}`);
    const b = ticks.get(`USD${pivot}`);
    if (a && b && a.bid > 0 && b.ask > 0) return a.bid / b.ask;
  }
  return 1;
}

/** Unrealized P/L in the account currency (USD) for one position. */
export function positionPnlUsd(position: Position, ticks: TickHub): number {
  const open = Number(position.open_price);
  const quote = ticks.get(position.instrument);
  const price = position.direction === "buy" ? quote?.bid : quote?.ask;
  if (!Number.isFinite(open) || open <= 0 || price === undefined) return 0;
  const { contractSize, quoteCurrency } = instrumentMeta(position.instrument);
  const diff = position.direction === "buy" ? price - open : open - price;
  const pnlQuote = diff * Number(position.volume) * contractSize;
  return pnlQuote * toUsd(quoteCurrency, ticks);
}

export function renderPositionsTable(
  view: AccountView,
  ticks: TickHub,
  limit = 12,
  width?: number,
  managedPositions?: AgentStateFile["openPositions"],
  scrollOffset = 0,
): string {
  if (view.positions.length === 0) return style.dim("  belum ada posisi terbuka");

  const wide = width === undefined || width >= 58;
  const mid = width === undefined || width >= 58;
  const slim = width === undefined || width >= 46;
  const managedById = new Map(
    (managedPositions ?? [])
      .filter((position) => position.positionId)
      .map((position) => [position.positionId!, position]),
  );

  const enriched = view.positions
    .map((pos) => {
      const digits = digitsFor(pos.instrument);
      const quote = ticks.get(pos.instrument);
      const now = pos.direction === "buy" ? quote?.bid : quote?.ask;
      const pips = positionPips(pos, quote);
      const sl = slPrice(pos, view);
      const managed = managedById.get(pos.position_id);
      const trail = Number(managed?.trail);
      const virtualTrail = Number.isFinite(trail) && trail > 0 ? trail : null;
      const pnlUsd = positionPnlUsd(pos, ticks);
      return { pos, digits, now, pips, sl, virtualTrail, pnlUsd };
    })
    .sort((a, b) => b.pnlUsd - a.pnlUsd);

  const start = Math.max(0, scrollOffset);
  const visible = enriched.slice(start, start + limit);

  const rows = visible.map(({ pos, digits, now, sl, virtualTrail, pnlUsd }) => {
    const pnlCell =
      pnlUsd >= 0 ? style.green(`$${pnlUsd.toFixed(2)}`) : style.red(`$${pnlUsd.toFixed(2)}`);
    const slCell = sl !== null ? formatNumber(sl, digits) : style.dim("—");
    const tsCell =
      virtualTrail === null
        ? style.dim("—")
        : virtualTrail > Number(pos.open_price) === (pos.direction === "buy")
          ? style.green(formatNumber(virtualTrail, digits))
          : style.cyan(formatNumber(virtualTrail, digits));

    if (wide) {
      return [
        style.bold(pos.instrument),
        sideLabel(pos.direction),
        Number(pos.volume).toFixed(2),
        formatNumber(Number(pos.open_price), digits),
        now !== undefined ? formatNumber(now, digits) : style.dim("—"),
        tsCell,
        slCell,
        pnlCell,
      ];
    }
    if (mid) {
      return [
        style.bold(pos.instrument),
        sideLabel(pos.direction),
        Number(pos.volume).toFixed(2),
        formatNumber(Number(pos.open_price), digits),
        now !== undefined ? formatNumber(now, digits) : style.dim("—"),
        tsCell,
        pnlCell,
      ];
    }
    if (slim) {
      return [
        style.bold(pos.instrument),
        sideLabel(pos.direction),
        now !== undefined ? formatNumber(now, digits) : style.dim("—"),
        tsCell,
        pnlCell,
      ];
    }
    return [style.bold(pos.instrument), sideLabel(pos.direction), tsCell, pnlCell];
  });

  const headers = wide
    ? ["SYMBOL", "SIDE", "LOT", "ENTRY", "NOW", "TS VIRT", "SL", "PNL $"]
    : mid
      ? ["SYMBOL", "SIDE", "LOT", "ENTRY", "NOW", "TS VIRT", "PNL $"]
      : slim
        ? ["SYMBOL", "SIDE", "NOW", "TS VIRT", "PNL $"]
        : ["SYMBOL", "SIDE", "TS VIRT", "PNL $"];
  const align: Record<number, "right"> = {};
  headers.forEach((_, index) => {
    if (index >= 2) align[index] = "right";
  });

  const header = table(headers, rows, { align, indent: "  " });
  const total = enriched.length;
  if (total > limit) {
    const end = Math.min(start + limit, total);
    return `${header}\n${style.dim(`  [${start + 1}-${end}/${total}] scroll ↑↓`)}`;
  }
  return header;
}

export function renderOrdersTable(
  view: AccountView,
  limit = 6,
  width?: number,
): string {
  const orders = view.orders.filter((order) => order.state === "placed");
  if (orders.length === 0) return style.dim("  belum ada order aktif");

  const showLot = width === undefined || width >= 60;
  const headers = showLot ? ["SYMBOL", "SL", "LOT"] : ["SYMBOL", "SL"];

  const rows = orders.slice(0, limit).map((order: Order) => {
    const instrument = order.instrument ?? "—";
    const digits = order.instrument ? digitsFor(order.instrument) : 5;
    const stopLoss = Number(order.stop_loss_price ?? 0);
    const sl = Number.isFinite(stopLoss) && stopLoss > 0 ? formatNumber(stopLoss, digits) : style.dim("—");
    if (showLot) {
      return [style.bold(instrument), sl, order.volume ? Number(order.volume).toFixed(2) : style.dim("—")];
    }
    return [style.bold(instrument), sl];
  });

  const align: Record<number, "right"> = {};
  headers.forEach((header, index) => {
    if (header !== "SYMBOL") align[index] = "right";
  });
  const body = table(headers, rows, { align, indent: "  " });
  const extra = orders.length - rows.length;
  return extra > 0 ? `${body}\n${style.dim(`  +${extra} SL lain`)}` : body;
}

// ------------------------------------------------------------------- history

export interface HistoryEntry {
  at: number;
  symbol: string;
  side?: string;
  volume?: number;
  pnl: number;
}

/**
 * Closed-trade history sorted by largest P/L, laid out in as many side-by-side
 * tables as the width allows (up to five). Scrolls with its own offset.
 */
export function renderHistoryTable(
  history: HistoryEntry[] | undefined,
  rows = 4,
  width = 60,
  scrollOffset = 0,
): string {
  if (!history || history.length === 0) return style.dim("  belum ada history close");

  const sorted = [...history].sort((a, b) => b.pnl - a.pnl);
  // Size each mini-table from the real data so nothing is ever truncated.
  const sample = sorted.slice(0, 200);
  const symbolWidth = Math.max(6, ...sample.map((entry) => entry.symbol.length));
  const pnlWidth = Math.max(5, ...sample.map((entry) => `$${entry.pnl.toFixed(2)}`.length));
  const columnWidth = 2 + symbolWidth + 2 + pnlWidth;
  const gap = 1;
  const columns = Math.max(
    1,
    Math.min(5, Math.floor((width + gap) / (columnWidth + gap))),
  );
  const perCol = Math.max(1, rows);
  const perPage = perCol * columns;
  const start = Math.max(0, Math.min(scrollOffset, Math.max(0, sorted.length - 1)));
  const page = sorted.slice(start, start + perPage);

  const renderColumn = (slice: HistoryEntry[]): string[] => {
    const headers = ["SYMBOL", "PNL $"];
    const body = slice.map((entry) => [
      style.bold(entry.symbol),
      entry.pnl >= 0 ? style.green(`$${entry.pnl.toFixed(2)}`) : style.red(`$${entry.pnl.toFixed(2)}`),
    ]);
    const tableLines = table(headers, body, { align: { 1: "right" }, indent: "  " })
      .split("\n")
      .map((line) => pad(line, columnWidth));
    const expected = perCol + 2;
    while (tableLines.length < expected) tableLines.push(" ".repeat(columnWidth));
    return tableLines.slice(0, expected);
  };

  const blocks = Array.from({ length: columns }, (_, index) =>
    renderColumn(page.slice(index * perCol, (index + 1) * perCol)),
  );
  const grid: string[] = [];
  for (let line = 0; line < perCol + 2; line += 1) {
    grid.push(blocks.map((block) => block[line] ?? "").join(" ".repeat(gap)));
  }

  const end = Math.min(start + perPage, sorted.length);
  const footer =
    sorted.length > perPage
      ? style.dim(`  [${start + 1}-${end}/${sorted.length}] · PgUp/PgDn scroll history`)
      : "";
  return footer ? `${grid.join("\n")}\n${footer}` : grid.join("\n");
}

// --------------------------------------------------------------------- risk

export function spreadSpikes(ticks: TickHub): number {
  const quotes = ticks.store.all();
  if (quotes.length < 5) return 0;
  // Absolute threshold (5 bp) instead of a median multiple: exotic pairs are
  // structurally wide, so a relative measure would flag them permanently.
  return quotes.filter((quote) => Number.isFinite(quote.spreadPct) && quote.spreadPct >= 0.05)
    .length;
}

export function exposureByCurrency(positions: Position[]): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const position of positions) {
    const base = position.instrument.slice(0, 3);
    totals.set(base, (totals.get(base) ?? 0) + Number(position.volume));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

export function renderRiskLines(
  view: AccountView,
  ticks: TickHub,
  equity: EquityTracker,
  halted: boolean,
): string {
  const change = view.equity - (equity.startBalance || view.balance);
  const lots = view.positions.reduce((sum, position) => sum + Number(position.volume), 0);
  const exposure = exposureByCurrency(view.positions)
    .slice(0, 4)
    .map(([currency, volume]) => `${currency} ${volume.toFixed(2)}`)
    .join(" · ");
  const spikes = spreadSpikes(ticks);
  const tickAge = ticks.lastTickAt ? Date.now() - ticks.lastTickAt : Number.POSITIVE_INFINITY;

  return [
    `  posisi ${view.positions.length} · lot ${lots.toFixed(2)}${exposure ? ` · eksposur ${exposure}` : ""}`,
    `  daily P/L ${formatSignedMoney(change, view.currency)} · tanpa batas posisi / daily loss`,
    `  kill switch ${halted ? style.red("ON — entry diblokir + semua posisi ditutup") : style.green("OFF")} · spread lebar ${spikes > 0 ? style.yellow(String(spikes)) : style.dim("0")} pair · tick terakhir ${tickAge === Number.POSITIVE_INFINITY ? style.dim("—") : `${tickAge}ms`}`,
  ].join("\n");
}

// ------------------------------------------------------------------- events

function toneText(tone: RuntimeEvent["tone"], text: string): string {
  if (tone === "success") return style.green(text);
  if (tone === "error") return style.red(text);
  if (tone === "warn") return style.yellow(text);
  return text;
}

export function renderEventLines(events: RuntimeEvent[], limit = 6): string {
  if (events.length === 0) return style.dim("  belum ada event");
  return events
    .slice(-limit)
    .map((event) => {
      const time = style.dim(clockTime(event.at));
      const type = event.type.padEnd(20);
      return `  ${time}  ${toneText(event.tone, type)} ${event.summary}`;
    })
    .join("\n");
}

// --------------------------------------------------------------------- agent

export interface AgentStateFile {
  running?: boolean;
  mode?: string;
  updatedAt?: number;
  universe?: number;
  nextScanAt?: number;
  timeframes?: {
    screener?: string;
    trend?: string;
    confirm?: string;
    trail?: string;
  };
  screener?: {
    at?: number;
    durationMs?: number;
    pass?: number;
    candidates?: Array<{
      symbol?: string;
      direction?: string;
      score?: number;
      spreadPct?: number;
      spreadPips?: number;
      rsi?: number;
      atrPct?: number;
      reasons?: string[];
    }>;
    diagnostics?: {
      universe?: number;
      withQuote?: number;
      fresh?: number;
      prefiltered?: number;
      shortlist?: number;
      candleFails?: number;
      scored?: number;
      passed?: number;
      top?: Array<{ symbol?: string; prelim?: number; spreadPips?: number; mom5?: number | null }>;
    };
  };
  lastSignal?: {
    at?: number;
    symbol?: string;
    side?: string;
    lot?: number;
    entry?: number;
    sl?: number;
    trail?: number;
    score?: number;
  } | null;
  trailing?: Array<{ at?: number; symbol?: string; positionId?: string; sl?: number }>;
  openPositions?: Array<{
    positionId?: string;
    symbol?: string;
    side?: string;
    volume?: number;
    entry?: number;
    /** broker emergency SL */
    sl?: number;
    /** program-side virtual trailing stop */
    trail?: number;
    best?: number;
    trailDistance?: number;
    atr?: number;
    score?: number;
  }>;
  stats?: {
    trades?: number;
    wins?: number;
    losses?: number;
    flats?: number;
    winRate?: number;
    netProfit?: number;
    consecutiveLosses?: number;
  };
  dailyPnl?: number;
  note?: string;
  activity?: AgentActivity[];
}

export function readAgentState(cacheDir: string): AgentStateFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, "agent-state.json"), "utf8")) as AgentStateFile;
  } catch {
    return null;
  }
}

export function renderAgentLines(agent: AgentStateFile | null): string {
  if (!agent) {
    return style.dim(
      "  agent belum berjalan · file .cache/agent-state.json tidak ditemukan",
    );
  }
  const lines: string[] = [];
  lines.push(
    `  status ${agent.running ? style.green("running") : style.dim("idle")} · mode ${agent.mode ?? "—"} · ${agent.universe ?? 0} pairs · update ${agent.updatedAt ? formatTime(agent.updatedAt) : "—"}`,
  );

  const stats = agent.stats;
  if (stats && (stats.trades ?? 0) > 0) {
    lines.push(
      `  trades ${stats.trades} · winrate ${(stats.winRate ?? 0).toFixed(1)}% (${stats.wins ?? 0}W/${stats.losses ?? 0}L/${stats.flats ?? 0}flat) · net ${formatSignedMoney(stats.netProfit ?? 0)}`,
    );
  } else {
    lines.push(style.dim("  belum ada trade tertutup"));
  }

  if (agent.dailyPnl !== undefined && Math.abs(agent.dailyPnl) > 0.001) {
    lines.push(`  daily P/L ${formatSignedMoney(agent.dailyPnl)}`);
  }

  const candidates = agent.screener?.candidates ?? [];
  if (candidates.length > 0) {
    lines.push(
      `  kandidat ${candidates
        .slice(0, 5)
        .map(
          (candidate) =>
            `${candidate.symbol ?? "?"} ${candidate.direction ?? ""} ${(candidate.score ?? 0).toFixed(1)}`,
        )
        .join(" · ")}`,
    );
  } else {
    lines.push(style.dim("  belum ada kandidat dari screener"));
  }

  const open = agent.openPositions ?? [];
  if (open.length > 0) {
    lines.push(
      `  dikelola ${open
        .slice(0, 4)
        .map(
          (position) =>
            `${position.symbol ?? "?"} ${position.side ?? ""} ${position.volume ?? "?"}@${position.entry ?? "?"} SL ${position.sl ?? "?"} TS ${position.trail ?? "?"}`,
        )
        .join(" · ")}`,
    );
  }

  const signal = agent.lastSignal;
  lines.push(
    signal
      ? `  sinyal terakhir ${gateSide(signal.side)} ${signal.symbol ?? "?"} lot ${signal.lot ?? "—"} entry ${signal.entry ?? "—"} SL ${signal.sl ?? "—"} trail ${signal.trail ?? "—"}`
      : style.dim("  belum ada sinyal entry"),
  );
  const trailing = agent.trailing ?? [];
  if (trailing.length > 0) {
    lines.push(
      `  virtual trail ${trailing
        .slice(-4)
        .map((entry) => `${entry.symbol ?? "?"}→${entry.sl ?? "?"}`)
        .join(" · ")}`,
    );
  }
  if (agent.note) lines.push(style.dim(`  ${agent.note}`));
  return lines.join("\n");
}

function gateSide(side: string | undefined): string {
  if (side === "buy") return style.green("BUY");
  if (side === "sell") return style.red("SELL");
  return "—";
}

/** Five dense lines sized for the side-by-side agent card. */
function agentPanelLines(agent: AgentStateFile | null | undefined): string[] {
  if (!agent) {
    return [
      style.dim("agent belum berjalan"),
      "",
      style.dim("jalankan `npm start`"),
      "",
      "",
    ];
  }
  const stats = agent.stats;
  const open = agent.openPositions ?? [];
  const candidates = agent.screener?.candidates ?? [];
  const signal = agent.lastSignal;
  const trailing = (agent.trailing ?? []).slice(-3);
  const decided = (stats?.wins ?? 0) + (stats?.losses ?? 0);
  const winRate = stats?.winRate ?? (decided > 0 ? ((stats?.wins ?? 0) / decided) * 100 : 0);

  const lines = [
    `${agent.running ? style.green("● running") : style.dim("○ idle")} · ` +
      `${agent.mode === "live" ? style.green("LIVE") : style.yellow("DRY-RUN")} · ` +
      `${agent.universe ?? 0} pairs · ${agent.screener?.pass ?? candidates.length} kandidat`,
    stats && stats.trades
      ? `trades ${stats.trades} · win ${winRate.toFixed(1)}% ` +
        `(${stats.wins ?? 0}W/${stats.losses ?? 0}L) · net ${formatSignedMoney(stats.netProfit ?? 0)}`
      : style.dim("belum ada trade tertutup"),
    `daily ${formatSignedMoney(agent.dailyPnl ?? 0)} · open ${open.length} · ` +
      `scan ${agent.updatedAt ? formatAge(Date.now() - agent.updatedAt) : "—"} lalu`,
    signal
      ? `last ${gateSide(signal.side)} ${signal.symbol ?? "?"} · ${signal.lot ?? 0} lot · ` +
        `entry ${signal.entry ?? "—"} · SL ${signal.sl ?? "—"}`
      : style.dim("belum ada sinyal entry"),
    trailing.length > 0
      ? `virtual ${trailing.map((entry) => `${entry.symbol ?? "?"}→${entry.sl ?? "?"}`).join(" ")}`
      : agent.note
        ? style.dim(agent.note)
        : style.dim("virtual trail menunggu pergerakan"),
  ];
  return lines;
}

/** Five dense lines sized for the side-by-side risk card. */
function riskPanelLines(
  view: AccountView,
  ticks: TickHub,
  equity: EquityTracker,
  halted: boolean,
): string[] {
  const change = view.equity - (equity.startBalance || view.balance);
  const lots = view.positions.reduce((sum, position) => sum + Number(position.volume), 0);
  const exposure = exposureByCurrency(view.positions)
    .slice(0, 3)
    .map(([currency, volume]) => `${currency} ${volume.toFixed(2)}`)
    .join(" · ");
  const spikes = spreadSpikes(ticks);
  const tickAge = ticks.lastTickAt ? `${Date.now() - ticks.lastTickAt}ms` : "—";
  return [
    `pos ${view.positions.length} · lots ${lots.toFixed(2)} · free ${formatCompactMoney(view.freeMargin)}`,
    `daily ${formatSignedMoney(change, view.currency)} · no cap`,
    `lvl ${view.usedMargin > 0 ? formatCompactPct(view.marginLevel) : "—"} · kill ${halted ? style.red("ON") : style.green("OFF")}`,
    `wide ${spikes > 0 ? style.yellow(String(spikes)) : style.dim("0")} · tick ${tickAge}`,
    exposure ? `exposure ${exposure}` : style.dim("belum ada exposure"),
  ];
}

// ------------------------------------------------------- per-agent containers

const AGENT_LABEL: Record<AgentRole, string> = {
  screener: "SCREENER",
  entry: "ENTRY",
  trader: "TRADER",
};

function agentColor(role: AgentRole): (text: string) => string {
  if (role === "screener") return style.cyan;
  if (role === "entry") return style.green;
  return style.yellow;
}

function agentTag(role: AgentRole): string {
  return agentColor(role)(AGENT_LABEL[role].padEnd(8));
}

function shortClock(epochMs: number): string {
  return clockTime(epochMs).slice(0, 8);
}

function agentMode(agent: AgentStateFile | null | undefined): string {
  if (!agent || !agent.running) return style.dim("idle");
  return agent.mode === "live" ? style.green("LIVE") : style.yellow("DRY-RUN");
}

function lastAgentActivity(
  agent: AgentStateFile | null | undefined,
  role: AgentRole,
): string | undefined {
  const entries = (agent?.activity ?? []).filter((entry) => entry.agent === role);
  return entries[entries.length - 1]?.message;
}

/** Recent log lines for one agent role, shown under its own card. */
function conciseAgentMessage(entry: AgentActivity): string {
  const message = entry.message.replace(/\s+/g, " ").trim();
  const symbol = message.match(/\b([A-Z][A-Z0-9._-]{2,})\b/g)?.find((token) =>
    !["CLOSE", "OPEN", "TS", "SL", "TRAIL", "ERROR", "ERR", "SKIP", "SCAN", "ENTRY", "BUY", "SELL", "PASS", "NO", "SIGNAL", "PROTECT", "ADOPT", "VIRTUAL", "HIT"].includes(token),
  );

  if (entry.agent === "trader") {
    const pnl = message.match(/net (-?\d+(?:\.\d+)?) USD/i);
    if (/close|closed|net /i.test(message) && pnl) {
      // Always retain the instrument on close events; the P/L is realized later.
      return `CLOSE ${symbol ?? "?"} ${Number(pnl[1]) >= 0 ? "+" : ""}${Number(pnl[1]).toFixed(2)}`;
    }
    const lock = message.match(/profit-lock activated.*?\+?([0-9.]+) USD/i);
    if (lock) return `TS ${symbol ?? "?"} +${Number(lock[1]).toFixed(2)}`;
    const opened = message.match(/open ([A-Z0-9._-]+) ([0-9.]+) lot.*?@ ([0-9.]+)/i);
    if (opened) return `OPEN ${opened[1]} ${opened[2]} @ ${opened[3]}`;
    const trail = message.match(/→\s*([0-9.]+)/);
    const pips = message.match(/trail ([0-9.]+)p/i);
    if (/trail|TS VIRTUAL hit/i.test(message)) {
      return trail
        ? `TS ${symbol ?? "?"} → ${trail[1]}`
        : pips ? `TS ${symbol ?? "?"} dist ${pips[1]}p` : `TS ${symbol ?? "?"} moved`;
    }
    if (/emergency SL tightened/i.test(message)) {
      const sl = message.match(/sl[: =]+([0-9.]+)/i);
      return `SL ${symbol ?? "?"} ${sl ? `→ ${sl[1]}` : "adjusted"}`;
    }
    if (/close failed/i.test(message)) return `CLOSE ERR ${symbol ?? "?"}`;
    if (/\b(open|adopt)\b/i.test(message)) return `OPEN ${symbol ?? "?"}`;
    if (/\b(skip|error)\b/i.test(message)) return `${/error/i.test(message) ? "ERR" : "SKIP"} ${symbol ?? ""}`.trim();
  }

  if (entry.agent === "screener") {
    if (/no setup|no candidate|no signal|filtered|reject/i.test(message)) return `NO SETUP ${symbol ?? ""}`.trim();
    if (/candidate|shortlist|passed|pass/i.test(message)) return `PASS ${symbol ?? ""}`.trim();
    if (/scan/i.test(message)) return `SCAN ${symbol ?? ""}`.trim();
    if (/error|failed/i.test(message)) return `SCAN ERR ${symbol ?? ""}`.trim();
  }

  if (entry.agent === "entry") {
    const side = message.match(/\b(buy|sell)\b/i)?.[1]?.toUpperCase();
    const lot = message.match(/([0-9]+(?:\.[0-9]+)?)\s*lot/i)?.[1];
    if (/reject|blocked|skip|denied/i.test(message)) return `REJECT ${symbol ?? ""}`.trim();
    if (/confirm|opened|placed|executed|entry/i.test(message)) {
      return [side ?? "ENTRY", symbol, lot ? `${lot}L` : undefined].filter(Boolean).join(" ");
    }
    if (/error|failed/i.test(message)) return `ENTRY ERR ${symbol ?? ""}`.trim();
  }

  // Let panel.fitLine truncate against the actual available inner width, right before the border.
  return message;
}

function agentLogLines(
  agent: AgentStateFile | null | undefined,
  role: AgentRole,
  limit = 4,
): string[] {
  const entries = (agent?.activity ?? []).filter((entry) => entry.agent === role);
  if (entries.length === 0) return [style.dim("· belum ada log")];
  return entries.slice(-limit).map((entry) => {
    const message = conciseAgentMessage(entry);
    const closePnl = entry.agent === "trader"
      ? message.match(/^CLOSE\\s+\\S+\\s+([+-]?\\d+(?:\\.\\d+)?)$/i)
      : null;
    const text = closePnl
      ? Number(closePnl[1]) < 0
        ? style.red(message)
        : Number(closePnl[1]) > 0
          ? style.green(message)
          : style.dim(message)
      : entry.tone === "error"
        ? style.red(message)
        : entry.tone === "warn"
          ? style.yellow(message)
          : entry.tone === "success"
            ? style.green(message)
            : style.dim(message);
    return `${style.dim(shortClock(entry.at))} ${text}`;
  });
}

function withLog(title: string, lines: string[], log: string[]): string[] {
  return [...lines, style.dim("─".repeat(Math.max(4, title.length))) , ...log];
}

function screenerPanelLines(agent: AgentStateFile | null | undefined): string[] {
  if (!agent) {
    return [
      style.dim("belum ada agent-state.json"),
      style.dim("jalankan `npm start`"),
      style.dim("─ log ─"),
      style.dim("· belum ada log"),
    ];
  }
  const screener = agent.screener;
  const diagnostics = screener?.diagnostics;
  const age = screener?.at ? formatAge(Date.now() - screener.at) : "—";
  const duration = ((screener?.durationMs ?? 0) / 1000).toFixed(1);
  const timeframes = agent.timeframes;
  const head = [
    `${agentMode(agent)} · ${timeframes?.screener ?? "M1"}→${timeframes?.trend ?? "M15"} · ${agent.universe ?? 0} pairs`,
    diagnostics
      ? `scan ${duration}s · fresh ${diagnostics.fresh ?? 0}/${diagnostics.withQuote ?? 0} · short ${diagnostics.shortlist ?? 0}`
      : `scan ${age} lalu · ${screener?.pass ?? 0} kandidat`,
    diagnostics
      ? `pass ${diagnostics.passed ?? 0} · fail ${diagnostics.candleFails ?? 0} · ${age} lalu`
      : style.dim("menunggu scan pertama"),
  ];
  return withLog("SCREENER", head, agentLogLines(agent, "screener", 4));
}

function entryPanelLines(agent: AgentStateFile | null | undefined): string[] {
  if (!agent) {
    return [
      style.dim("menunggu sinyal"),
      style.dim("─ log ─"),
      style.dim("· belum ada log"),
    ];
  }
  const signal = agent.lastSignal;
  const open = agent.openPositions ?? [];
  const timeframes = agent.timeframes;
  const head = [
    `${agentMode(agent)} · signals ${signal ? 1 : 0} · open ${open.length}`,
    signal
      ? `last ${gateSide(signal.side)} ${signal.symbol ?? "?"} · lot ${signal.lot || "—"}`
      : style.dim("belum ada sinyal entry"),
    signal
      ? `entry ${signal.entry ?? "—"} · SL ${signal.sl ?? "—"} · trail ${signal.trail ?? "—"}`
      : style.dim(`${timeframes?.confirm ?? "M1"} close → entry → risk`),
  ];
  return withLog("ENTRY", head, agentLogLines(agent, "entry", 4));
}

function traderPanelLines(agent: AgentStateFile | null | undefined): string[] {
  if (!agent) {
    return [
      style.dim("belum ada posisi dikelola"),
      style.dim("─ log ─"),
      style.dim("· belum ada log"),
    ];
  }
  const stats = agent.stats;
  const open = agent.openPositions ?? [];
  const trailing = open.filter((position) => (position.trail ?? 0) > 0).length;
  const decided = (stats?.wins ?? 0) + (stats?.losses ?? 0);
  const winRate = stats?.winRate ?? (decided > 0 ? ((stats?.wins ?? 0) / decided) * 100 : 0);
  const head = [
    `${agentMode(agent)} · ${open.length} managed · ${trailing} virtual`,
    `${stats?.trades ?? 0} trades · win ${decided > 0 ? `${winRate.toFixed(1)}%` : "—"} · ` +
      `${stats?.wins ?? 0}W/${stats?.losses ?? 0}L`,
    `net ${formatSignedMoney(stats?.netProfit ?? 0)} · daily ${formatSignedMoney(agent.dailyPnl ?? 0)}`,
  ];
  return withLog("TRADER", head, agentLogLines(agent, "trader", 4));
}

export function renderAgentContainers(
  agent: AgentStateFile | null | undefined,
  width: number,
): string {
  const status = agent?.running ? "live" : "idle";
  if (width >= 96) {
    const widths = splitWidths(width, 3, 1);
    return row(
      [
        panel(`SCREENER · ${status}`, screenerPanelLines(agent), widths[0]!, "cyan"),
        panel(`ENTRY · ${status}`, entryPanelLines(agent), widths[1]!, "green"),
        panel(`TRADER · ${status}`, traderPanelLines(agent), widths[2]!, "yellow"),
      ],
      " ",
    );
  }
  return [
    panel(`SCREENER · ${status}`, screenerPanelLines(agent), width, "cyan"),
    panel(`ENTRY · ${status}`, entryPanelLines(agent), width, "green"),
    panel(`TRADER · ${status}`, traderPanelLines(agent), width, "yellow"),
  ].join("\n");
}

export function renderAgentLogLines(
  agent: AgentStateFile | null | undefined,
  limit = 5,
): string[] {
  const activity = (agent?.activity ?? []).slice(-Math.max(1, limit));
  if (activity.length === 0) {
    return [style.dim("  belum ada aktivitas agent · jalankan `npm start`")];
  }
  const lines = activity.map((entry) => {
    const message = conciseAgentMessage(entry);
    // Closed P/L color follows the realized amount, not the generic log tone.
    const closePnl = entry.agent === "trader"
      ? message.match(/^CLOSE\s+\S+\s+([+-]?\d+(?:\.\d+)?)$/i)
      : null;
    const text = closePnl
      ? Number(closePnl[1]) < 0
        ? style.red(message)
        : Number(closePnl[1]) > 0
          ? style.green(message)
          : style.dim(message)
      : entry.tone === "error"
        ? style.red(message)
        : entry.tone === "warn"
          ? style.yellow(message)
          : entry.tone === "success"
            ? style.green(message)
            : style.dim(message);
    return `${style.dim(shortClock(entry.at))} ${text}`;
  });
  if (!agent?.running) {
    lines.push(style.yellow("  agent idle · jalankan `npm start` di terminal ini"));
  }
  return lines;
}

// ---------------------------------------------------------- account / market

export function accountPanelLines(state: DashboardState): string[] {
  const { view, equity } = state;
  const stats = equity.stats();
  const level =
    view.usedMargin > 0 ? formatCompactPct(view.marginLevel) : style.dim("—");
  return [
    `id ${style.bold(view.accountId)} · ${style.bold(view.name)}`,
    `${view.isDemo ? style.yellow("DEMO") : style.green("LIVE")} · ${view.status} · trade ${view.tradeMode}`,
    `${view.executionMode} · 1:${view.leverage} · ${view.currency}`,
    `balance ${formatCompactMoney(view.balance)} · equity ${formatCompactMoney(view.equity)}`,
    `used ${formatCompactMoney(view.usedMargin)} · lvl ${level}`,
    `today ${formatSignedMoney(stats.change, view.currency)} (${formatSignedPct(stats.changePct)})`,
    `unreal ${formatSignedMoney(view.unrealized, view.currency)} · ` +
      `${view.positions.length} pos · ${view.orders.length} ord`,
  ];
}

export function marketPanelLines(ticks: TickHub): string[] {
  const quotes = ticks.store.all().filter((quote) => Number.isFinite(quote.mid) && quote.mid > 0);
  // A first tick has firstMid === mid, so every symbol looks like a 0.00%
  // mover. Only rank instruments that have actually changed at least once.
  const movers = quotes
    .filter((quote) => quote.ticks > 1)
    .sort((a, b) => Math.abs(changePct(b)) - Math.abs(changePct(a)))
    .slice(0, 3)
    .map((quote) => `${quote.symbol} ${formatSignedPct(changePct(quote), 2)}`)
    .join(" · ");
  const spreads = quotes
    .map((quote) => quote.spreadPct * 100)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const average = spreads.length
    ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length
    : 0;
  const widest = quotes.reduce<Quote | undefined>(
    (best, quote) => (!best || quote.spreadPct > best.spreadPct ? quote : best),
    undefined,
  );
  const age = ticks.lastTickAt ? `${Date.now() - ticks.lastTickAt}ms` : "—";
  return [
    `quotes ${ticks.quotesCount} live · ${ticks.subscribed.length} ws · ${ticks.ticksPerSecond}/s`,
    `ticks ${ticks.state} · last ${age}`,
    movers ? `top ${movers}` : style.dim("menunggu tick"),
    `avg spread ${average.toFixed(1)}bp`,
    widest
      ? `wide ${widest.symbol} ${(widest.spreadPct * 100).toFixed(1)}bp`
      : style.dim("menunggu spread"),
  ];
}

// ------------------------------------------------------------------ footer

export interface DashboardScroll {
  offset: number;
  visible: number;
  total: number;
}

export function renderDashboardFooter(
  state: DashboardState,
  options: { width: number; killArmed?: boolean; scroll?: DashboardScroll },
): string {
  const width = Math.max(20, options.width);
  if (options.killArmed) {
    return cutAnsi(style.red("  KILL ARMED · y confirm: block entries + close all · n cancel"), width);
  }
  const paused = state.paused ? " · PAUSED" : "";
  const keys =
    "  q quit · p pause · a agents · c chart · o orders · e events · " +
    `r refresh · x kill · u unkill${paused} · wheel/↑↓ pos · PgUp/PgDn hist`;
  const scroll =
    options.scroll && options.scroll.total > options.scroll.visible
      ? `  ${options.scroll.offset + 1}-${Math.min(
          options.scroll.offset + options.scroll.visible,
          options.scroll.total,
        )}/${options.scroll.total}`
      : "";
  return cutAnsi(`${style.dim(keys)}${style.dim(scroll)}`, width);
}

// ---------------------------------------------------------------- dashboard

export interface DashboardState {
  view: AccountView;
  ticks: TickHub;
  events: RuntimeEvent[];
  equity: EquityTracker;
  connection: {
    ticksState: SocketState;
    eventsState: SocketState;
    accessPoint: string;
  };
  startedAt: number;
  paused: boolean;
  showOrders: boolean;
  showEvents: boolean;
  showAgent: boolean;
  showCharts: boolean;
  halted: boolean;
  agent?: AgentStateFile | null;
  posScroll?: number;
  histScroll?: number;
  history?: HistoryEntry[];
}

export interface DashboardLayout {
  width: number;
  height: number;
  footer?: boolean;
}

function renderHeader(state: DashboardState, width: number): string {
  const mode = state.view.isDemo ? style.yellow("DEMO") : style.green("LIVE");
  const paused = state.paused ? ` ${style.yellow("PAUSED")}` : "";
  const halted = state.halted ? ` ${style.red("HALTED")}` : "";
  const left = `${style.bold("open-trader")} ${mode} ${state.view.name} ${style.dim(state.view.accountId)}${paused}${halted}`;
  const right = `${new Date().toISOString().slice(11, 19)} UTC`;
  const gap = Math.max(2, width - visibleLength(left) - right.length);
  return `${left}${" ".repeat(gap)}${style.dim(right)}`;
}

export function renderAccountLines(state: DashboardState): string {
  const { view, equity } = state;
  const stats = equity.stats();
  const change = formatSignedMoney(stats.change, view.currency);
  const changePct = formatSignedPct(stats.changePct, 2);
  const unrealized =
    view.unrealized === 0 ? style.dim(formatMoney(0, view.currency)) : formatSignedMoney(view.unrealized, view.currency);
  const marginLevel =
    view.usedMargin > 0 ? `${view.marginLevel.toLocaleString("en-US", { maximumFractionDigits: 0 })}%` : style.dim("—");
  const age = state.ticks.lastTickAt ? `${Date.now() - state.ticks.lastTickAt}ms` : "—";

  return [
    `  ${style.dim("balance")} ${style.bold(formatMoney(view.balance, view.currency))}   ${style.dim("equity")} ${style.bold(formatMoney(view.equity, view.currency))}   ${style.dim("margin")} ${formatMoney(view.usedMargin, view.currency)}   ${style.dim("free")} ${formatMoney(view.freeMargin, view.currency)}`,
    `  ${style.dim("today")} ${change} ${style.dim(`(${changePct})`)}   ${style.dim("unrealized")} ${unrealized}   ${style.dim("margin level")} ${marginLevel}   ${style.dim("leverage")} 1:${view.leverage}`,
    `  ${style.dim("ticks")} ${dot(state.connection.ticksState)} ${state.ticks.ticksPerSecond} /s ${style.dim(`(age ${age})`)}   ${style.dim("events")} ${dot(state.connection.eventsState)}   ${style.dim("pairs")} ${state.ticks.quotesCount} live / ${state.ticks.subscribed.length} ws   ${style.dim("ap")} ${state.connection.accessPoint.replace(/^https?:\/\//, "")}`,
  ].join("\n");
}

/** Stack blocks vertically with no gap so the whole board stays compact. */
function stack(blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join("\n");
}

export function renderDashboard(state: DashboardState, layout: DashboardLayout): string {
  const width = Math.max(100, layout.width);
  const height = Math.max(24, layout.height);
  const inner = width - 4;
  const { view, equity } = state;
  const stats = equity.stats();
  const lots = view.positions.reduce((sum, position) => sum + Number(position.volume), 0);
  const marginLevel =
    view.usedMargin > 0 ? formatCompactPct(view.marginLevel) : style.dim("—");

  // ---------------------------------------------------------------- header
  const mode = view.isDemo ? style.yellow("DEMO") : style.green("LIVE");
  const flags = `${state.paused ? ` ${style.yellow("PAUSED")}` : ""}${state.halted ? ` ${style.red("HALTED")}` : ""}`;
  const header = panel(
    `open-trader · ${view.isDemo ? "DEMO" : "LIVE"}`,
    [
      spreadLine(
        `${style.bold(view.name)} ${style.dim(view.accountId)}${flags}`,
        style.dim(`${new Date().toISOString().slice(11, 19)} UTC`),
        inner,
      ),
      spreadLine(
        `${mode} · ${view.status} · ${view.executionMode} · 1:${view.leverage} · ${view.currency}`,
        `${style.dim("ticks")} ${dot(state.connection.ticksState)} ${state.ticks.ticksPerSecond}/s · ` +
          `${style.dim("events")} ${dot(state.connection.eventsState)} · ` +
          `${state.ticks.quotesCount} live/${state.ticks.subscribed.length} ws`,
        inner,
      ),
    ],
    width,
    view.isDemo ? "yellow" : "green",
  );

  // ------------------------------------------------- agent row (own logs)
  const agentBlock = state.showAgent ? renderAgentContainers(state.agent, width) : "";

  // ---------------------------------------------------- side-by-side columns
  const [leftWidth, rightWidth] = splitWidths(width, 2, 1);
  const [cardA, cardB] = splitWidths(leftWidth, 2, 1);

  const kpi = stack([
    row(
      [
        panel(
          "BALANCE",
          [style.bold(formatMoney(view.balance, view.currency)), style.dim(`start ${formatMoney(stats.start, view.currency)}`)],
          cardA!,
          "cyan",
        ),
        panel(
          "EQUITY",
          [
            style.bold(formatMoney(view.equity, view.currency)),
            `${formatSignedMoney(stats.change, view.currency)} ${style.dim(`(${formatSignedPct(stats.changePct)})`)}`,
          ],
          cardB!,
          "green",
        ),
      ],
      " ",
    ),
    row(
      [
        panel(
          "FREE MARGIN",
          [style.bold(formatMoney(view.freeMargin, view.currency)), style.dim(`lvl ${marginLevel} · used ${formatCompactMoney(view.usedMargin)}`)],
          cardA!,
          "blue",
        ),
        panel(
          "POSITIONS",
          [style.bold(`${view.positions.length} open · ${lots.toFixed(2)} lot`), `${style.dim("unreal")} ${formatSignedMoney(view.unrealized, view.currency)}`],
          cardB!,
          "magenta",
        ),
      ],
      " ",
    ),
  ]);

  const accountBlock = panel(
    "ACCOUNT",
    [
      `${view.isDemo ? style.yellow("DEMO") : style.green("LIVE")} · ${view.status} · trade ${view.tradeMode}`,
      `bal ${formatCompactMoney(view.balance)} · eq ${formatCompactMoney(view.equity)} · free ${formatCompactMoney(view.freeMargin)}`,
      `used ${formatCompactMoney(view.usedMargin)} · lvl ${marginLevel}`,
      `${view.executionMode} · 1:${view.leverage} · ${view.currency} · ${view.orders.length} ord`,
    ],
    leftWidth,
    "gray",
  );

  // ------------------------------------------------ layout budget
  // header (4) + agent row (10) + footer (1)
  const bottomRows = height >= 44 ? 5 : height >= 40 ? 4 : 3;
  const bottomPanelH = bottomRows + 2;
  const mainHeight = Math.max(10, height - 15);

  // Left column: KPI cards + P&L chart + account + history (below account, same width)
  const leftBaseBlocks = [kpi];
  let used = kpi.split("\n").length;
  const accountH = 6;
  const canAccount = mainHeight >= used + accountH + bottomPanelH + 3;
  const chartHeight = Math.max(
    4,
    Math.min(
      6,
      mainHeight - used - (canAccount ? accountH : 0) - bottomPanelH - 8,
    ),
  );

  let chartStart = "";
  if (state.showCharts && chartHeight >= 4) {
    const pnlPoints: ChartPoint[] = equity
      .points()
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value));
    const chartLines = pixelPnlChart(pnlPoints, {
      width: leftWidth - 2,
      height: chartHeight,
      currency: view.currency,
      title: "PNL TODAY",
    }).split("\n");
    chartStart = panel("P&L · today", chartLines, leftWidth, "blue", true);
    leftBaseBlocks.push(chartStart);
  } else if (state.showCharts) {
    const pnlPoints: ChartPoint[] = equity
      .points()
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value));
    const chartLines = pixelPnlChart(pnlPoints, {
      width: leftWidth - 2,
      height: 4,
      currency: view.currency,
      title: "PNL TODAY",
    }).split("\n");
    chartStart = panel("P&L · today", chartLines, leftWidth, "blue", true);
    leftBaseBlocks.push(chartStart);
  }
  if (canAccount) leftBaseBlocks.push(accountBlock);

  const historyBlockLeft = panel(
    `HISTORY · ${state.history?.length ?? 0} close · sort P&L$ · PgUp/PgDn`,
    renderHistoryTable(state.history, bottomRows, leftWidth - 4, state.histScroll ?? 0).split("\n"),
    leftWidth,
    "gray",
  );
  leftBaseBlocks.push(historyBlockLeft);

  let leftColumn = stack(leftBaseBlocks);
  let leftHeight = leftColumn.split("\n").length;
  // Pad or trim to the agreed main height so both columns stay aligned.
  if (leftHeight < mainHeight) {
    leftColumn += `\n${Array.from({ length: mainHeight - leftHeight }, () => " ".repeat(leftWidth)).join("\n")}`;
    leftHeight = mainHeight;
  } else if (leftHeight > mainHeight) {
    leftColumn = leftColumn.split("\n").slice(0, mainHeight).join("\n");
    leftHeight = mainHeight;
  }

  // Order rows, then positions fill the rest and events take bottom height
  const ordersRows = state.showOrders
    ? Math.max(2, Math.min(5, Math.floor(mainHeight / 7)))
    : 0;
  const ordersBlock = state.showOrders
    ? panel(
        `ORDERS · ${view.orders.length} SL`,
        renderOrdersTable(view, ordersRows, rightWidth).split("\n"),
        rightWidth,
        "cyan",
      )
    : "";
  const ordersHeight = ordersBlock ? ordersBlock.split("\n").length : 0;

  const buildPositions = (rows: number): { block: string; height: number } => {
    const block = panel(
      `POSITIONS · ${view.positions.length} open · ${lots.toFixed(2)} lot · sort P&L$`,
      renderPositionsTable(
        view,
        state.ticks,
        rows,
        rightWidth,
        state.agent?.openPositions,
        state.posScroll ?? 0,
      ).split("\n"),
      rightWidth,
      "magenta",
    );
    return { block, height: block.split("\n").length };
  };

  let posRows = Math.max(3, leftHeight - ordersHeight - bottomPanelH - 2);
  let positions = buildPositions(posRows);
  while (
    leftHeight - positions.height - ordersHeight - 2 < bottomPanelH &&
    posRows > 3
  ) {
    posRows -= 1;
    positions = buildPositions(posRows);
  }

  const eventsBlock = state.showEvents
    ? (() => {
        const lines = renderEventLines(state.events, bottomRows).split("\n");
        while (lines.length < bottomRows) lines.push("");
        return panel(`EVENTS · ${state.events.length}`, lines, rightWidth, "gray");
      })()
    : "";

  const rightColumn = stack([positions.block, ordersBlock, eventsBlock].filter(Boolean));
  const main = row([leftColumn, rightColumn], " ");

  return stack([header, agentBlock, main]);
}

export function quoteSummary(quote: Quote | undefined): string {
  if (!quote) return "—";
  const digits = digitsFor(quote.symbol);
  return `${formatNumber(quote.bid, digits)} / ${formatNumber(quote.ask, digits)} (${changePct(quote).toFixed(3)}%)`;
}