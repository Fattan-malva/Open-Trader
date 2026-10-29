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

export interface PixelChartOptions extends ChartOptions {
  title?: string;
}

// Setiap pixel adalah kotak kecil; antar kolom diberi satu spasi.
const PIXEL = "■";
const PNL_UP = "\x1b[38;2;0;230;160m";
const PNL_UP_HEAD = "\x1b[38;2;170;255;225m";
const PNL_DOWN = "\x1b[38;2;255;85;105m";
const PNL_DOWN_HEAD = "\x1b[38;2;255;175;185m";
const RESET = "\x1b[0m";

function signMoney(value: number, currency: string, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const amount = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${sign}${amount}${currency ? ` ${currency}` : ""}`;
}

function sampleColumns(points: ChartPoint[], columns: number): ChartPoint[] {
  if (points.length === 0 || columns <= 0) return [];

  if (points.length === 1) {
    return Array.from({ length: columns }, () => ({ ...points[0]! }));
  }

  const result: ChartPoint[] = [];
  const step = (points.length - 1) / Math.max(1, columns - 1);

  for (let i = 0; i < columns; i += 1) {
    const idx = i * step;
    const i0 = Math.floor(idx);
    const i1 = Math.min(points.length - 1, i0 + 1);
    const frac = idx - i0;
    const p0 = points[i0]!;
    const p1 = points[i1]!;

    result.push({
      t: Math.round(p0.t + (p1.t - p0.t) * frac),
      value: p0.value + (p1.value - p0.value) * frac,
    });
  }

  return result;
}

/**
 * Grafik PnL berbasis kotak pixel kecil, rata kiri, tanpa sumbu, tanpa garis
 * dasar, dan tanpa grid. Setiap sampel data = satu kolom kotak; batang tumbuh
 * dari nol ke nilai saat ini. Hijau untuk PnL positif, merah untuk negatif,
 * dan pixel puncak lebih terang.
 */
export function pixelPnlChart(
  points: ChartPoint[],
  options: PixelChartOptions = {},
): string {
  const totalWidth = Math.max(12, options.width ?? terminalWidth());
  const currency = options.currency ?? "USD";
  const pixelRows = Math.max(3, options.height ?? 10);
  const title = options.title ?? "TOTAL PROFIT";

  if (points.length === 0) {
    return style.dim("belum ada data untuk digambar");
  }

  // Pastikan data diurutkan berdasarkan waktu.
  const ordered = [...points]
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value))
    .sort((a, b) => a.t - b.t);

  if (ordered.length === 0) {
    return style.dim("belum ada data valid untuk digambar");
  }

  // Buang sampel awal yang masih nol (belum ada pergerakan) supaya grafik
  // mulai dari tepi kiri panel, bukan dari tengah.
  const firstMove = ordered.findIndex((p) => Math.abs(p.value) > 1e-9);
  const active = firstMove > 0 ? ordered.slice(firstMove) : ordered;

  // Satu kotak + satu spasi per kolom. Jika data lebih sedikit dari slot yang
  // tersedia, data tidak di-stretch: kotak berjajar rapat dari kiri panel.
  const slots = Math.max(1, Math.floor((totalWidth + 1) / 2));
  const sampled = active.length <= slots ? active : sampleColumns(active, slots);
  let values = sampled.map((p) => p.value);

  // Nol selalu berada dalam skala agar batang positif dan negatif terbaca.
  let minValue = Math.min(0, ...values);
  let maxValue = Math.max(0, ...values);

  if (maxValue - minValue < 1e-12) {
    minValue = -1;
    maxValue = 1;
  } else {
    const padding = (maxValue - minValue) * 0.1;
    minValue -= padding;
    maxValue += padding;
  }

  const range = maxValue - minValue;
  const toRow = (value: number): number =>
    Math.max(
      0,
      Math.min(
        pixelRows - 1,
        Math.round(((maxValue - value) / range) * (pixelRows - 1)),
      ),
    );

  const zeroRow = toRow(0);
  let headRows = values.map(toRow);

  // Buang kolom awal yang tidak punya pixel sama sekali (nilai terlalu kecil
  // untuk digambar), supaya kolom pertama yang tampil ada di tepi kiri panel.
  const firstLit = headRows.findIndex((row) => row !== zeroRow);
  if (firstLit > 0) {
    values = values.slice(firstLit);
    headRows = headRows.slice(firstLit);
  }
  const count = values.length;

  const lastValue = values[count - 1] ?? 0;
  const change = lastValue - (ordered[0]?.value ?? 0);

  // Baris yang menyala untuk satu kolom: dari garis nol sampai puncak nilai.
  // Nilai yang tepat nol tidak menggambar batang sama sekali.
  const isLit = (col: number, row: number): boolean => {
    const head = headRows[col]!;
    if (head === zeroRow) return false;
    return row >= Math.min(head, zeroRow) && row <= Math.max(head, zeroRow);
  };

  const lines: string[] = [];

  const headingColor = lastValue >= 0 ? PNL_UP : PNL_DOWN;
  lines.push(`${headingColor}▰ ${title}  ${signMoney(lastValue, currency)}${RESET}`);

  for (let row = 0; row < pixelRows; row += 1) {
    let line = "";

    for (let col = 0; col < count; col += 1) {
      if (isLit(col, row)) {
        const onHead = headRows[col] === row;
        const up = values[col]! >= 0;
        const color = up
          ? onHead ? PNL_UP_HEAD : PNL_UP
          : onHead ? PNL_DOWN_HEAD : PNL_DOWN;
        line += `${color}${PIXEL}${RESET}`;
      } else {
        line += " ";
      }
      if (col < count - 1) line += " ";
    }

    lines.push(line);
  }

  const changeColor = change >= 0 ? PNL_UP : PNL_DOWN;
  lines.push(
    `${style.dim("CHANGE")} ${changeColor}${signMoney(change, currency)}${RESET}`,
  );

  return lines.join("\n");
}

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
  const clockLabel = (epochMs: number): string => new Date(epochMs).toISOString().slice(11, 16);
  place(clockLabel(first.t), 0);
  if (last.t - first.t > 60_000) {
    place(clockLabel(first.t + (last.t - first.t) / 2), Math.floor(columns / 2) - 3);
    place(clockLabel(last.t), columns - 6);
  }
  const timeLine = `${" ".repeat(axisWidth + 1)} ${style.dim(timeLabels.join(""))}`;

  return [...rowsOut, axisLine, timeLine].join("\n");
}

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

export interface LineChartOptions extends ChartOptions {
  tone?: "auto" | "accent" | "danger";
  baseline?: number;
}