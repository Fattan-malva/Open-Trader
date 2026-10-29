import type { Tick } from "../exness/types.js";

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  spreadPct: number;
  /** epoch milliseconds of the last tick */
  timestamp: number;
  ticks: number;
  firstMid: number;
}

export class QuoteStore {
  private readonly quotes = new Map<string, Quote>();
  private lastTickAt = 0;

  upsert(tick: Tick): Quote {
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    const mid = (bid + ask) / 2;
    const timestamp = Date.parse(tick.timestamp) || Date.now();
    const existing = this.quotes.get(tick.instrument);

    const quote: Quote = existing
      ? {
          ...existing,
          bid,
          ask,
          mid,
          spread: ask - bid,
          spreadPct: mid === 0 ? 0 : ((ask - bid) / mid) * 100,
          timestamp,
          ticks: existing.ticks + 1,
        }
      : {
          symbol: tick.instrument,
          bid,
          ask,
          mid,
          spread: ask - bid,
          spreadPct: mid === 0 ? 0 : ((ask - bid) / mid) * 100,
          timestamp,
          ticks: 1,
          firstMid: mid,
        };

    this.quotes.set(tick.instrument, quote);
    this.lastTickAt = Date.now();
    return quote;
  }

  get(symbol: string): Quote | undefined {
    return this.quotes.get(symbol.toUpperCase());
  }

  all(): Quote[] {
    return [...this.quotes.values()];
  }

  get size(): number {
    return this.quotes.size;
  }

  get lastTick(): number {
    return this.lastTickAt;
  }
}

export function changePct(quote: Quote): number {
  if (quote.firstMid === 0) return 0;
  return ((quote.mid - quote.firstMid) / quote.firstMid) * 100;
}

export function formatNumber(value: number, digits: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
