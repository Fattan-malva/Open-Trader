import type { Quote } from "../market/store.js";
import type { NormalizedCandle } from "../market/candles.js";
import { dropFormingCandle, pipSize } from "../market/candles.js";
import {
  atr,
  atrPercent,
  clamp,
  closes,
  ema,
  lastFinite,
  rsi,
} from "../market/indicators.js";
import { timeframeMs, type Timeframe } from "../market/timeframes.js";
import type { Tools } from "../tools/index.js";
import type { TickHub } from "../runtime/hubs.js";
import type { AgentConfig } from "./config.js";
import { spreadLabel, spreadPips, spreadQuality, spreadWithinLimit } from "./spread.js";
import { trailDistanceFromAtr } from "./trailing.js";

export type Direction = "buy" | "sell";

export interface Candidate {
  symbol: string;
  direction: Direction;
  score: number;
  price: number;
  spreadPct: number;
  spreadPips: number;
  /** screener-timeframe ATR, used for the virtual trail */
  atr: number;
  atrPct: number;
  /** spread as a fraction of the virtual trail distance */
  spreadRatio: number;
  /** screener-timeframe EMA50 — the pullback anchor */
  ema50: number;
  /** trend-timeframe EMA50/EMA200 context */
  trendEma50: number;
  trendEma200: number;
  rsi: number;
  /** trend EMA separation in trend ATRs, aligned to the trade direction */
  trendAtr: number;
  /** trend-timeframe ATR, used for the broker emergency stop */
  trendAtrValue: number;
  /** distance from the last screener close to EMA50, in screener ATRs */
  distanceAtr: number;
  reasons: string[];
  /** closed screener candles only */
  candles: NormalizedCandle[];
}

export interface ScreenerOptions {
  screenerTimeframe: Timeframe;
  trendTimeframe: Timeframe;
  shortlistSize: number;
  maxCandidates: number;
  minScore: number;
  maxSpreadPips: number;
  maxSpreadPct: number;
  maxSpreadTrailRatio: number;
  minAtrPct: number;
  maxAtrPct: number;
  pullbackDistanceAtr: number;
  minTrendAtr: number;
  rsiMin: number;
  rsiMax: number;
  maxQuoteAgeMs: number;
  trailAtrFactor: number;
  trailMinPips: number;
}

interface MomentumSample {
  t: number;
  mid: number;
}

const MOMENTUM_WINDOW_MS = 15 * 60_000;
const SAMPLE_INTERVAL_MS = 1_000;

/**
 * Tick-only momentum memory. It is used only to rank the prefilter shortlist
 * (which pairs are active enough to be worth two candle requests); it is not a
 * hard screener criterion.
 */
export class MomentumTracker {
  private readonly samples = new Map<string, MomentumSample[]>();

  observe(quote: Quote): void {
    const series = this.samples.get(quote.symbol) ?? [];
    const last = series[series.length - 1];
    if (last && quote.timestamp - last.t < SAMPLE_INTERVAL_MS) {
      last.mid = quote.mid;
      last.t = quote.timestamp;
      return;
    }
    series.push({ t: quote.timestamp, mid: quote.mid });
    const cutoff = quote.timestamp - MOMENTUM_WINDOW_MS;
    while (series.length > 1 && series[0]!.t < cutoff) series.shift();
    this.samples.set(quote.symbol, series);
  }

  changePct(symbol: string, minutes: number): number | null {
    const series = this.samples.get(symbol);
    if (!series || series.length < 2) return null;
    const latest = series[series.length - 1]!;
    const target = latest.t - minutes * 60_000;
    if (latest.t - series[0]!.t < minutes * 60_000 * 0.75) return null;

    let reference: MomentumSample | undefined;
    for (const sample of series) {
      if (sample.t <= target) reference = sample;
      else break;
    }
    reference ??= series[0]!;
    if (reference.mid === 0) return null;
    return ((latest.mid - reference.mid) / reference.mid) * 100;
  }

  size(): number {
    return this.samples.size;
  }
}

export interface CandleScoreInput {
  symbol: string;
  /** closed screener-timeframe candles */
  screener: NormalizedCandle[];
  /** closed trend-timeframe candles */
  trend: NormalizedCandle[];
  quote: Quote;
  options: ScreenerOptions;
}

/**
 * Pure candle scoring:
 *
 *   1. trend EMA50 above/below EMA200 -> trend direction
 *   2. screener RSI in the middle band and price near screener EMA50
 *   3. spread below the limit and cheap relative to the virtual trail
 *
 * No take-profit and no momentum hard gate.
 */
export function scoreCandidate(input: CandleScoreInput): Candidate | null {
  const { symbol, screener, trend, quote, options } = input;
  if (screener.length < 60 || trend.length < 210) return null;

  const trendCloses = closes(trend);
  const trendEma50 = lastFinite(ema(trendCloses, 50));
  const trendEma200 = lastFinite(ema(trendCloses, 200));
  const trendAtrValue = lastFinite(atr(trend, 14));
  if (
    trendEma50 === undefined ||
    trendEma200 === undefined ||
    trendAtrValue === undefined ||
    trendAtrValue <= 0
  ) {
    return null;
  }

  const trendSeparation = (trendEma50 - trendEma200) / trendAtrValue;
  if (Math.abs(trendSeparation) < options.minTrendAtr) return null;
  const direction: Direction = trendSeparation > 0 ? "buy" : "sell";
  const sign = direction === "buy" ? 1 : -1;
  const trendAtr = trendSeparation * sign;

  const screenerCloses = closes(screener);
  const screenerEma50 = lastFinite(ema(screenerCloses, 50));
  const screenerAtr = lastFinite(atr(screener, 14));
  const screenerRsi = lastFinite(rsi(screenerCloses, 14));
  const close = screenerCloses[screenerCloses.length - 1];
  if (
    screenerEma50 === undefined ||
    screenerAtr === undefined ||
    screenerAtr <= 0 ||
    screenerRsi === undefined ||
    close === undefined
  ) {
    return null;
  }

  // Pullback zone: RSI in the middle of its range, price near EMA50.
  if (screenerRsi < options.rsiMin || screenerRsi > options.rsiMax) return null;
  const distanceAtr = (close - screenerEma50) / screenerAtr;
  if (Math.abs(distanceAtr) > options.pullbackDistanceAtr) return null;

  const atrPct = atrPercent(screener, screenerAtr);
  if (atrPct < options.minAtrPct || atrPct > options.maxAtrPct) return null;
  if (!spreadWithinLimit(symbol, quote, options)) return null;

  // Spread is a real cost, not just a screen: rejecting an edge that is mostly
  // eaten by the spread is what keeps a more aggressive scan profitable.
  const trailDistance = trailDistanceFromAtr(
    screenerAtr,
    options.trailAtrFactor,
    options.trailMinPips * pipSize(symbol),
  );
  const spreadRatio = trailDistance > 0 ? quote.spread / trailDistance : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(spreadRatio) || spreadRatio > options.maxSpreadTrailRatio) return null;

  const trendScore = clamp(trendAtr / 1.2, 0, 1) * 40;
  const pullbackScore =
    clamp(1 - Math.abs(distanceAtr) / Math.max(options.pullbackDistanceAtr, 1e-9), 0, 1) * 25;
  const rsiScore = clamp(1 - Math.abs(screenerRsi - 50) / 10, 0, 1) * 20;
  const spreadScore = spreadQuality(symbol, quote, options) * 15;
  const score = trendScore + pullbackScore + rsiScore + spreadScore;
  if (score < options.minScore) return null;

  const reasons = [
    `${options.trendTimeframe} ${direction === "buy" ? "uptrend" : "downtrend"} ${trendAtr.toFixed(2)}×ATR`,
    `pullback ${distanceAtr.toFixed(2)}×ATR`,
    `RSI ${screenerRsi.toFixed(0)}`,
    `spread ${spreadLabel(symbol, quote)}`,
    `ATR ${atrPct.toFixed(3)}%`,
    `cost ${(spreadRatio * 100).toFixed(0)}% trail`,
  ];

  return {
    symbol,
    direction,
    score,
    price: close,
    spreadPct: quote.spreadPct,
    spreadPips: spreadPips(symbol, quote),
    atr: screenerAtr,
    atrPct,
    spreadRatio,
    ema50: screenerEma50,
    trendEma50,
    trendEma200,
    rsi: screenerRsi,
    trendAtr,
    trendAtrValue,
    distanceAtr,
    reasons,
    candles: screener,
  };
}

export interface ScanDiagnostics {
  universe: number;
  withQuote: number;
  fresh: number;
  prefiltered: number;
  shortlist: number;
  candleFails: number;
  scored: number;
  passed: number;
  /** Highest prefilter scores, useful to see why a pair reached the shortlist. */
  top: Array<{ symbol: string; prelim: number; spreadPips: number; mom5: number | null }>;
}

export class Screener {
  readonly momentum = new MomentumTracker();
  lastScanAt = 0;
  lastScanDurationMs = 0;
  /** M15 candles only change once per trend candle; reuse them across scans. */
  private readonly trendCache = new Map<
    string,
    { boundary: number; candles: NormalizedCandle[] }
  >();
  lastDiagnostics: ScanDiagnostics = {
    universe: 0,
    withQuote: 0,
    fresh: 0,
    prefiltered: 0,
    shortlist: 0,
    candleFails: 0,
    scored: 0,
    passed: 0,
    top: [],
  };

  constructor(
    private readonly tools: Tools,
    private readonly ticks: TickHub,
    private readonly options: ScreenerOptions,
  ) {}

  observe(quote: Quote): void {
    this.momentum.observe(quote);
  }

  private async trendCandles(
    symbol: string,
    now: number,
  ): Promise<NormalizedCandle[] | null> {
    const duration = timeframeMs(this.options.trendTimeframe);
    const boundary = Math.floor(now / duration) * duration;
    const cached = this.trendCache.get(symbol);
    if (cached && cached.boundary === boundary) return cached.candles;

    const result = await this.tools.get_candles({
      symbol,
      timeframe: this.options.trendTimeframe,
      n: 260,
    });
    if (!result.ok) return null;
    const candles = dropFormingCandle(result.data, duration, now);
    if (candles.length < 210) return null;
    this.trendCache.set(symbol, { boundary, candles });
    return candles;
  }

  async scan(universe: string[]): Promise<Candidate[]> {
    const started = Date.now();
    this.lastScanAt = started;

    const now = Date.now();
    type Pre = { quote: Quote; mom5: number | null; prelim: number };
    const pre: Pre[] = [];
    let withQuote = 0;
    let fresh = 0;

    for (const symbol of universe) {
      const quote = this.ticks.get(symbol);
      if (!quote) continue;
      withQuote += 1;
      if (now - quote.timestamp > this.options.maxQuoteAgeMs) continue;
      fresh += 1;
      if (!spreadWithinLimit(symbol, quote, this.options)) continue;

      const mom5 = this.momentum.changePct(symbol, 5);
      const activity = clamp(quote.ticks / 20, 0, 1);
      const move = mom5 === null ? 0.35 : clamp(Math.abs(mom5) / 0.08, 0, 1);
      const prelim =
        spreadQuality(symbol, quote, this.options) * 60 + activity * 20 + move * 20;
      pre.push({ quote, mom5, prelim });
    }

    pre.sort((a, b) => b.prelim - a.prelim);
    const shortlist = pre.slice(0, this.options.shortlistSize);

    const candidates: Candidate[] = [];
    let candleFails = 0;
    let scored = 0;
    for (const entry of shortlist) {
      const symbol = entry.quote.symbol;
      const trend = await this.trendCandles(symbol, now);
      if (!trend) {
        candleFails += 1;
        continue;
      }
      const screenerResult = await this.tools.get_candles({
        symbol,
        timeframe: this.options.screenerTimeframe,
        n: 180,
      });
      if (!screenerResult.ok) {
        candleFails += 1;
        continue;
      }

      const screener = dropFormingCandle(
        screenerResult.data,
        timeframeMs(this.options.screenerTimeframe),
        now,
      );
      if (screener.length < 60) {
        candleFails += 1;
        continue;
      }

      scored += 1;
      const candidate = scoreCandidate({
        symbol,
        screener,
        trend,
        quote: entry.quote,
        options: this.options,
      });
      if (candidate) candidates.push(candidate);
    }

    candidates.sort((a, b) => b.score - a.score);
    this.lastScanDurationMs = Date.now() - started;
    const capped = candidates.slice(0, this.options.maxCandidates);
    this.lastDiagnostics = {
      universe: universe.length,
      withQuote,
      fresh,
      prefiltered: pre.length,
      shortlist: shortlist.length,
      candleFails,
      scored,
      passed: capped.length,
      top: shortlist.slice(0, 6).map((entry) => ({
        symbol: entry.quote.symbol,
        prelim: Number(entry.prelim.toFixed(1)),
        spreadPips: Number(spreadPips(entry.quote.symbol, entry.quote).toFixed(2)),
        mom5: entry.mom5 === null ? null : Number(entry.mom5.toFixed(3)),
      })),
    };
    return capped;
  }
}

export function screenerOptionsFrom(config: AgentConfig): ScreenerOptions {
  return {
    screenerTimeframe: config.screenerTimeframe,
    trendTimeframe: config.trendTimeframe,
    shortlistSize: config.shortlistSize,
    maxCandidates: config.maxCandidates,
    minScore: config.minScore,
    maxSpreadPips: config.maxSpreadPips,
    maxSpreadPct: config.maxSpreadPct,
    maxSpreadTrailRatio: config.maxSpreadTrailRatio,
    minAtrPct: config.minAtrPct,
    maxAtrPct: config.maxAtrPct,
    pullbackDistanceAtr: config.pullbackDistanceAtr,
    minTrendAtr: config.minTrendAtr,
    rsiMin: config.rsiMin,
    rsiMax: config.rsiMax,
    maxQuoteAgeMs: config.maxQuoteAgeMs,
    trailAtrFactor: config.trailAtrFactor,
    trailMinPips: config.trailMinPips,
  };
}
