import fs from "node:fs";
import path from "node:path";

import type { ChartPoint } from "../cli/chart.js";
import type { AccountView } from "../runtime/snapshot.js";

export interface EquitySample {
  t: number;
  balance: number;
  equity: number;
  usedMargin: number;
}

export interface EquityStats {
  start: number;
  end: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  samples: number;
  from: number;
  to: number;
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeysBack(days: number): string[] {
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    keys.push(localDateKey(date));
  }
  return keys;
}

/**
 * Equity sampler with day-scoped JSONL persistence. Survives restarts so the
 * P/L chart still covers the whole day, not just the current process.
 */
export class EquityTracker {
  readonly samples: EquitySample[] = [];

  private lastRecordAt = 0;
  private lastEquity = Number.NaN;
  private loadedDays = 0;

  constructor(
    private readonly cacheDir: string,
    readonly currency = "USD",
    private readonly intervalMs = 5000,
  ) {}

  get dir(): string {
    return path.join(this.cacheDir, "equity");
  }

  loadDays(days: number): void {
    this.samples.length = 0;
    this.loadedDays = Math.max(1, days);
    for (const key of dateKeysBack(this.loadedDays)) {
      const file = path.join(this.dir, `${key}.jsonl`);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const sample = JSON.parse(line) as EquitySample;
          if (Number.isFinite(sample.t) && Number.isFinite(sample.equity)) {
            this.samples.push(sample);
          }
        } catch {
          // ignore corrupt line
        }
      }
    }
    this.samples.sort((a, b) => a.t - b.t);

    const last = this.samples[this.samples.length - 1];
    if (last) {
      this.lastRecordAt = last.t;
      this.lastEquity = last.equity;
    }
  }

  loadToday(): void {
    this.loadDays(1);
  }

  /** Returns true when a new sample was stored. */
  record(view: AccountView, force = false): boolean {
    const now = Date.now();
    if (
      !force &&
      now - this.lastRecordAt < this.intervalMs &&
      Math.abs(view.equity - this.lastEquity) < 1
    ) {
      return false;
    }

    const sample: EquitySample = {
      t: now,
      balance: view.balance,
      equity: view.equity,
      usedMargin: view.usedMargin,
    };
    this.samples.push(sample);
    if (this.samples.length > 50_000) this.samples.splice(0, this.samples.length - 50_000);
    this.lastRecordAt = now;
    this.lastEquity = view.equity;
    this.persist(sample);
    return true;
  }

  get latest(): EquitySample | undefined {
    return this.samples[this.samples.length - 1];
  }

  get startBalance(): number {
    return this.samples[0]?.balance ?? this.latest?.balance ?? 0;
  }

  points(): ChartPoint[] {
    return this.samples.map((sample) => ({
      t: sample.t,
      value: sample.equity - this.startBalance,
    }));
  }

  stats(): EquityStats {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) {
      const zero = {
        start: 0,
        end: 0,
        change: 0,
        changePct: 0,
        high: 0,
        low: 0,
        maxDrawdown: 0,
        maxDrawdownPct: 0,
        samples: 0,
        from: Date.now(),
        to: Date.now(),
      };
      return zero;
    }

    const start = first.balance;
    let high = this.samples[0]!.equity;
    let low = this.samples[0]!.equity;
    let peak = this.samples[0]!.equity;
    let maxDrawdown = 0;

    for (const sample of this.samples) {
      if (sample.equity > high) high = sample.equity;
      if (sample.equity < low) low = sample.equity;
      if (sample.equity > peak) peak = sample.equity;
      maxDrawdown = Math.max(maxDrawdown, peak - sample.equity);
    }

    const change = last.equity - start;
    return {
      start,
      end: last.equity,
      change,
      changePct: start === 0 ? 0 : (change / start) * 100,
      high,
      low,
      maxDrawdown,
      maxDrawdownPct: start === 0 ? 0 : (maxDrawdown / start) * 100,
      samples: this.samples.length,
      from: first.t,
      to: last.t,
    };
  }

  private persist(sample: EquitySample): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const key = localDateKey(new Date(sample.t));
      fs.appendFileSync(path.join(this.dir, `${key}.jsonl`), `${JSON.stringify(sample)}\n`);
    } catch {
      // Best effort.
    }
  }
}
