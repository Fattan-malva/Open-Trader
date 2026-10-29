import { pad, style, terminalWidth } from "../cli/render.js";

export interface ChartPoint {
  /** epoch milliseconds */
  t: number;
  value: number;
}

export interface ChartOptions {
  height?: number;
  width?: number;
  currency?: string;
}

type Tone = "pos" | "neg" | "flat" | "none";

interface Cell {
  ch: string;
  tone: Tone;
}

function signMoney(value: number, currency: string, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const amount = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${sign}${amount}${currency ? ` ${currency}` : ""}`;
}

function clockLabel(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

function sampleColumns(points: ChartPoint[], columns: number): ChartPoint[] {
  if (points.length <= 0) return [];
  if (points.length <= columns) {
    // Interpolate to fill width for smoother look
    const result: ChartPoint[] = [];
    const step = points.length === 1 ? columns : (points.length - 1) / (columns - 1);
    for (let i = 0; i < columns; i += 1) {
      const idx = i * step;
      const i0 = Math.floor(idx);
      const i1 = Math.min(points.length - 1, i0 + 1);
      const frac = idx - i0;
      const p0 = points[i0]!;
      const p1 = points[i1]!;
      const t = Math.round(p0.t + (p1.t - p0.t) * frac);
      const v = p0.value + (p1.value - p0.value) * frac;
      result.push({ t, value: v });
    }
    return result;
  }
  // Downsample with linear interpolation for smoother curve
  const result: ChartPoint[] = [];
  const step = (points.length - 1) / (columns - 1);
  for (let i = 0; i < columns; i += 1) {
    const idx = i * step;
    const i0 = Math.floor(idx);
    const i1 = Math.min(points.length - 1, i0 + 1);
    const frac = idx - i0;
    const p0 = points[i0]!;
    const p1 = points[i1]!;
    const t = Math.round(p0.t + (p1.t - p0.t) * frac);
    const v = p0.value + (p1.value - p0.value) * frac;
    result.push({ t, value: v });
  }
  return result;
}

/**
 * Moving-average smoothing: removes the tick-to-tick noise so the plotted
 * curve reads as a trend instead of a sawtooth.
 */
function smooth(points: ChartPoint[]): ChartPoint[] {
  if (points.length < 5) return points;
  const half = Math.max(1, Math.round(points.length / 40));
  return points.map((point, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = index - half; offset <= index + half; offset += 1) {
      const sample = points[Math.min(points.length - 1, Math.max(0, offset))];
      if (!sample) continue;
      sum += sample.value;
      count += 1;
    }
    return { t: point.t, value: count > 0 ? sum / count : point.value };
  });
}

/**
 * Line-only chart: a continuous coloured line (no area fill) around a baseline,
 * with y labels, a zero marker and start/middle/end time labels. Sized to fit
 * inside a bordered dashboard panel.
 */
export function lineChart(points: ChartPoint[], options: LineChartOptions = {}): string {
  const totalWidth = options.width ?? terminalWidth();
  const currency = options.currency ?? "";
  const rows = Math.max(5, options.height ?? 9);
  const baseline = options.baseline ?? 0;

  if (points.length === 0) {
    return style.dim("  belum ada data untuk digambar");
  }

  const values = points.map((point) => point.value);
  let min = Math.min(...values, baseline);
  let max = Math.max(...values, baseline);
  if (max - min < 1e-9) {
    max += 2;
    min -= 2;
  }
  const padding = (max - min) * 0.2;
  const lo = min - padding;
  const hi = max + padding;

  const label = (value: number): string => signMoney(value, currency);
  const axisWidth = Math.max(12, label(max).length, label(min).length, label(baseline).length) + 1;
  const columns = Math.max(20, totalWidth - axisWidth - 4);
  const samplePoints = smooth(sampleColumns(points, columns));

  const toRow = (value: number): number => {
    const ratio = (hi - value) / (hi - lo);
    return Math.min(rows - 1, Math.max(0, Math.round(ratio * (rows - 1))));
  };

  const grid: Array<Array<string | null>> = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => null),
  );

  // Smooth diagonal line: one column always advances one row, so the curve
  // reads as a slope (╱ ╲) instead of a jagged wall of vertical bars.
  let previousRow: number | undefined;
  samplePoints.forEach((point, column) => {
    const row = toRow(point.value);
    if (previousRow === undefined) {
      grid[row]![column] = "●";
    } else if (previousRow === row) {
      grid[row]![column] = "─";
    } else if (row < previousRow) {
      grid[row]![column] = "╱";
      for (let r = row + 1; r < previousRow; r += 1) {
        grid[r]![column] = grid[r]![column] ?? "│";
      }
    } else {
      grid[row]![column] = "╲";
      for (let r = previousRow + 1; r < row; r += 1) {
        grid[r]![column] = grid[r]![column] ?? "│";
      }
    }
    previousRow = row;
  });
  const lastRow = previousRow;
  if (lastRow !== undefined) grid[lastRow]![columns - 1] = "●";

  const tone =
    options.tone === "danger"
      ? style.red
      : options.tone === "accent"
        ? style.cyan
        : points[points.length - 1]!.value >= baseline
          ? style.green
          : style.red;

  const baselineRow = toRow(baseline);
  const labels: Array<{ row: number; text: string }> = [];
  const usedRows = new Set<number>();
  for (const value of [max, baseline, min]) {
    const row = toRow(value);
    if (usedRows.has(row)) continue;
    usedRows.add(row);
    labels.push({ row, text: label(value) });
  }

  const rowsOut: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const text = labels.find((entry) => entry.row === r)?.text ?? "";
    const axis = r === baselineRow ? "┼" : "┤";
    const body = grid[r]!
      .map((cell) => (cell === null ? " " : cell))
      .join("");
    rowsOut.push(
      `${style.dim(pad(text, axisWidth, "right"))} ${style.dim(axis)}${tone(body)}`,
    );
  }

  const axisLine = `${" ".repeat(axisWidth)} ${style.dim(`└${"─".repeat(columns)}`)}`;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const timeLabels = new Array(columns).fill(" ") as string[];
  const place = (text: string, at: number): void => {
    const start = Math.max(0, Math.min(columns - text.length, at));
    for (let index = 0; index < text.length; index += 1) {
      timeLabels[start + index] = text[index]!;
    }
  };
  place(clockLabel(first.t), 0);
  if (last.t - first.t > 60_000) {
    place(clockLabel(first.t + (last.t - first.t) / 2), Math.floor(columns / 2) - 3);
    place(clockLabel(last.t), columns - 6);
  }
  const timeLine = `${" ".repeat(axisWidth + 1)} ${style.dim(timeLabels.join(""))}`;

  return [...rowsOut, axisLine, timeLine].join("\n");
}

export interface LineChartOptions extends ChartOptions {
  tone?: "auto" | "accent" | "danger";
  baseline?: number;
}

