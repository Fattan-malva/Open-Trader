const enabled = Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env);

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

type ColorName = keyof typeof CODES;

function paint(color: ColorName, text: string): string {
  if (!enabled) return text;
  return `${CODES[color]}${text}${CODES.reset}`;
}

export const style = {
  enabled,
  bold: (text: string) => paint("bold", text),
  dim: (text: string) => paint("dim", text),
  red: (text: string) => paint("red", text),
  green: (text: string) => paint("green", text),
  yellow: (text: string) => paint("yellow", text),
  blue: (text: string) => paint("blue", text),
  magenta: (text: string) => paint("magenta", text),
  cyan: (text: string) => paint("cyan", text),
  gray: (text: string) => paint("gray", text),
};

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  const diff = Math.max(0, width - visibleLength(text));
  return align === "right" ? " ".repeat(diff) + text : text + " ".repeat(diff);
}

export type Align = "left" | "right";

export interface TableOptions {
  align?: Record<number, Align>;
  headerColor?: boolean;
  indent?: string;
}

export function table(headers: string[], rows: string[][], options: TableOptions = {}): string {
  const widths = headers.map((header, index) =>
    Math.max(
      visibleLength(header),
      ...rows.map((row) => visibleLength(row[index] ?? "")),
    ),
  );

  const indent = options.indent ?? "";
  const line = (cells: string[], header = false): string => {
    const rendered = cells.map((cell, index) => {
      const align = options.align?.[index] ?? "left";
      const content = header && options.headerColor !== false ? style.bold(cell) : cell;
      return pad(content, widths[index] ?? 0, align);
    });
    return indent + rendered.join("  ").trimEnd();
  };

  const headerLine = line(headers, true);
  const separator = indent + widths.map((width) => "─".repeat(width)).join("  ");
  return [headerLine, style.gray(separator), ...rows.map((row) => line(row))].join("\n");
}

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function clockTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 23);
}

export function terminalWidth(): number {
  const columns = process.stdout.columns ?? 140;
  return Math.max(90, Math.min(columns, 220));
}

export function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
}

export function hideCursor(): void {
  if (process.stdout.isTTY) process.stdout.write("\u001b[?25l");
}

export function showCursor(): void {
  if (process.stdout.isTTY) process.stdout.write("\u001b[?25h");
}

export function moveHome(): void {
  if (process.stdout.isTTY) process.stdout.write("\u001b[H");
}
