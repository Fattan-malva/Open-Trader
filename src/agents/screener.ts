import type { Quote } from "../market/store.js";
import { categorize, type InstrumentCategory } from "../exness/catalog.js";
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
import {
  assessSpread,
  observeSpread,
  spreadLabel,
  spreadPips,
  spreadQuality,
} from "./spread.js";
import { trailDistanceFromAtr } from "./trailing.js";

export type Direction = "buy" | "sell";
export type SetupType = "pullback" | "breakout";

export interface Candidate {
  symbol: string;
  direction: Direction;
  setupType: SetupType;
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
  maxMetalSpreadPct?: number;
  maxCryptoSpreadPct?: number;
  maxEnergySpreadPct?: number;
  maxSpreadSpikeRatio: number;
  maxSpreadTrailRatio: number;
  minAtrPct: number;
  maxAtrPct: number;
  pullbackDistanceAtr: number;
  minTrendAtr: number;
  rsiMin: number;
  rsiMax: number;
  breakoutLookback: number;
  breakoutMinBodyAtr: number;
  breakoutRsiFloor: number;
  breakoutRsiCeiling: number;
  maxQuoteAgeMs: number;
  trailAtrFactor: number;
  trailMinPips: number;
}

interface MomentumSample {
  t: number;
  mid: number;
}

interface ActivityBin {
  second: number;
  ticks: number;
}

export interface RankedSymbol {
  quote: Quote;
  mom5: number | null;
  prelim: number;
}

const CATEGORY_SCAN_ORDER: InstrumentCategory[] = [
  "metals", "crypto", "energy", "fx", "other", "index", "stock",
];

/**
 * Keep the shortlist balanced across instrument categories, pin XAUUSD when
 * it has a fresh/in-cap quote, and rotate the non-top slots so one busy market
 * cannot permanently starve every other tradable symbol.
 */
export function selectFairShortlist(
  entries: RankedSymbol[],
  shortlistSize: number,
  now = Date.now(),
): RankedSymbol[] {
  if (entries.length === 0) return [];
  const groups = new Map<InstrumentCategory, RankedSymbol[]>();
  for (const entry of entries) {
    const category = categorize(entry.quote.symbol);
    const group = groups.get(category) ?? [];
    group.push(entry);
    groups.set(category, group);
  }

  const categories = CATEGORY_SCAN_ORDER.filter((category) => (groups.get(category)?.length ?? 0) > 0);
  const budget = Math.min(entries.length, Math.max(categories.length, Math.trunc(shortlistSize)));
  const baseQuota = Math.floor(budget / categories.length);
  const remainderQuota = budget % categories.length;
  const selected = new Map<string, RankedSymbol>();
  const rotationEpoch = Math.floor(now / 10_000);

  categories.forEach((category, categoryIndex) => {
    const group = (groups.get(category) ?? []).slice().sort((a, b) => b.prelim - a.prelim);
    const quota = baseQuota + (categoryIndex < remainderQuota ? 1 : 0);
    if (quota <= 0) return;

    const pinned = category === "metals"
      ? group.find((entry) => /^XAUUSD(?:$|[._-])/.test(entry.quote.symbol))
      : undefined;
    const ranked = group.filter((entry) => entry !== pinned);
    const available = Math.max(0, quota - (pinned ? 1 : 0));
    const hotCount = Math.min(available, Math.max(0, Math.ceil(available / 2)));
    const chosen: RankedSymbol[] = pinned ? [pinned] : [];
    chosen.push(...ranked.slice(0, hotCount));

    const rotationPool = ranked.slice(hotCount).sort((a, b) => a.quote.symbol.localeCompare(b.quote.symbol));
    const rotationSlots = Math.min(Math.max(0, quota - chosen.length), rotationPool.length);
    if (rotationPool.length > 0 && rotationSlots > 0) {
      const offset = (rotationEpoch * rotationSlots) % rotationPool.length;
      for (let i = 0; i < rotationSlots; i += 1) {
        chosen.push(rotationPool[(offset + i) % rotationPool.length]!);
      }
    }
    for (const entry of chosen) selected.set(entry.quote.symbol, entry);
  });

  // If a category contains fewer symbols than its quota, reassign the unused
  // slots to the best remaining quotes rather than returning an undersized list.
  const fallback = entries.slice().sort((a, b) => b.prelim - a.prelim);
  for (const entry of fallback) {
    if (selected.size >= budget) break;
    selected.set(entry.quote.symbol, entry);
  }
  return [...selected.values()].sort((a, b) => b.prelim - a.prelim).slice(0, budget);
}

const MOMENTUM_WINDOW_MS = 15 * 60_000;
const ACTIVITY_WINDOW_MS = 60_000;
const SAMPLE_INTERVAL_MS = 1_000;

/**
 * Tick-only momentum memory. It is used to rank the shortlist (which symbols
 * are active enough to justify candle requests), not as a standalone trade signal.
 */
export class MomentumTracker {
  private readonly samples = new Map<string, MomentumSample[]>();
  private readonly activity = new Map<string, ActivityBin[]>();

  observe(quote: Quote): void {
    const activity = this.activity.get(quote.symbol) ?? [];
    const second = Math.floor(quote.timestamp / 1_000) * 1_000;
    const latestBin = activity[activity.length - 1];
    if (latestBin && latestBin.second === second) {
      latestBin.ticks += 1;
    } else {
      activity.push({ second, ticks: 1 });
    }
    const activityCutoff = quote.timestamp - ACTIVITY_WINDOW_MS;
    while (activity.length > 0 && activity[0]!.second < activityCutoff) activity.shift();
    while (activity.length > 60) activity.shift();
    this.activity.set(quote.symbol, activity);

    const series = this.samples.get(quote.symbol) ?? [];
    const last = series[series.length - 1];
    if (last && quote.timestamp >= last.t && quote.timestamp - last.t < SAMPLE_INTERVAL_MS) {
      last.mid = quote.mid;
      return;
    }
    series.push({ t: quote.timestamp, mid: quote.mid });
    const cutoff = quote.timestamp - MOMENTUM_WINDOW_MS;
    while (series.length > 1 && series[0]!.t < cutoff) series.shift();
    this.samples.set(quote.symbol, series);
  }

  /** Number of ticks seen for a symbol during the trailing 60-second window. */
  ticksLastMinute(symbol: string, now = Date.now()): number {
    const cutoff = now - ACTIVITY_WINDOW_MS;
    return (this.activity.get(symbol) ?? []).reduce(
      (sum, sample) => sum + (sample.second >= cutoff && sample.second <= now + 1_000 ? sample.ticks : 0),
      0,
    );
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
  onReject?: (reason: string) => void;
}

/**
 * Score two setup families under the same higher-timeframe bias:
 * - pullback: price is near the screener EMA50 with an RSI that is not extreme;
 * - breakout: a closed candle breaks the prior range with a directional body.
 *
 * The score ranks valid setup quality. Hard spread, volatility, trend and
 * execution-risk gates remain in force for both families.
 */
export function scoreCandidate(input: CandleScoreInput): Candidate | null {
  const { symbol, screener, trend, quote, options } = input;
  const reject = (reason: string): null => {
    input.onReject?.(reason);
    return null;
  };
  if (screener.length < 60 || trend.length < 210) return reject("insufficient-candles");

  const trendCloses = closes(trend);
  const trendEma50 = lastFinite(ema(trendCloses, 50));
  const trendEma200 = lastFinite(ema(trendCloses, 200));
  const trendAtrValue = lastFinite(atr(trend, 14));
  if (
    trendEma50 === undefined ||
    trendEma200 === undefined ||
    trendAtrValue === undefined ||
    trendAtrValue <= 0
  ) return reject("trend-indicators-not-ready");

  const trendSeparation = (trendEma50 - trendEma200) / trendAtrValue;
  if (Math.abs(trendSeparation) < options.minTrendAtr) return reject("trend-too-weak");
  const direction: Direction = trendSeparation > 0 ? "buy" : "sell";
  const sign = direction === "buy" ? 1 : -1;
  const trendAtr = trendSeparation * sign;

  const screenerCloses = closes(screener);
  const screenerEma50 = lastFinite(ema(screenerCloses, 50));
  const screenerAtr = lastFinite(atr(screener, 14));
  const screenerRsi = lastFinite(rsi(screenerCloses, 14));
  const last = screener[screener.length - 1];
  const close = screenerCloses[screenerCloses.length - 1];
  if (
    screenerEma50 === undefined ||
    screenerAtr === undefined ||
    screenerAtr <= 0 ||
    screenerRsi === undefined ||
    close === undefined ||
    !last
  ) return reject("screener-indicators-not-ready");

  const atrPct = atrPercent(screener, screenerAtr);
  if (atrPct < options.minAtrPct || atrPct > options.maxAtrPct) return reject("atr-out-of-range");
  const spread = assessSpread(symbol, quote, options);
  if (!spread.ok) return reject(spread.reason?.startsWith("spread spike") ? "spread-spike" : "spread-rejected");

  const trailDistance = trailDistanceFromAtr(
    screenerAtr,
    options.trailAtrFactor,
    options.trailMinPips * pipSize(symbol),
  );
  const spreadRatio = trailDistance > 0
    ? quote.spread / trailDistance
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(spreadRatio) || spreadRatio > options.maxSpreadTrailRatio) return reject("spread-vs-trail");

  const distanceAtr = (close - screenerEma50) / screenerAtr;
  const pullbackOk =
    screenerRsi >= options.rsiMin &&
    screenerRsi <= options.rsiMax &&
    Math.abs(distanceAtr) <= options.pullbackDistanceAtr;

  const lookback = Math.max(3, Math.trunc(options.breakoutLookback));
  const prior = screener.slice(-(lookback + 1), -1);
  const bodyAtr = Math.abs(last.close - last.open) / screenerAtr;
  const priorHigh = prior.length > 0 ? Math.max(...prior.map((candle) => candle.high)) : Number.NaN;
  const priorLow = prior.length > 0 ? Math.min(...prior.map((candle) => candle.low)) : Number.NaN;
  const breakoutRsiOk = direction === "buy"
    ? screenerRsi <= options.breakoutRsiCeiling
    : screenerRsi >= options.breakoutRsiFloor;
  const breakoutOk = prior.length >= lookback &&
    bodyAtr >= options.breakoutMinBodyAtr &&
    breakoutRsiOk &&
    (direction === "buy"
      ? last.close > last.open && last.close > priorHigh
      : last.close < last.open && last.close < priorLow);

  if (!pullbackOk && !breakoutOk) return reject("no-valid-setup");

  const trendScore = clamp(trendAtr / 1.2, 0, 1) * 30;
  const spreadScore = spreadQuality(symbol, quote, options) * 20;
  const neutralRsiScore = clamp(1 - Math.abs(screenerRsi - 50) / 25, 0, 1) * 15;
  const pullbackScore = clamp(
    1 - Math.abs(distanceAtr) / Math.max(options.pullbackDistanceAtr, 1e-9),
    0,
    1,
  ) * 30;

  const breakoutMomentumScore = direction === "buy"
    ? clamp((screenerRsi - 45) / 30, 0, 1) * 15
    : clamp((55 - screenerRsi) / 30, 0, 1) * 15;
  const breakoutStructureScore = 30 + clamp(bodyAtr, 0, 1) * 5;

  const possible: Array<{ setupType: SetupType; score: number; reasons: string[] }> = [];
  if (pullbackOk) {
    possible.push({
      setupType: "pullback",
      score: trendScore + pullbackScore + neutralRsiScore + spreadScore,
      reasons: [
        `pullback ${distanceAtr.toFixed(2)}×ATR from EMA50`,
        `RSI ${screenerRsi.toFixed(0)}`,
      ],
    });
  }
  if (breakoutOk) {
    possible.push({
      setupType: "breakout",
      score: trendScore + breakoutStructureScore + breakoutMomentumScore + spreadScore,
      reasons: [
        `breakout ${lookback}-bar range`,
        `body ${bodyAtr.toFixed(2)}×ATR`,
        `RSI momentum ${screenerRsi.toFixed(0)}`,
      ],
    });
  }
  possible.sort((a, b) => b.score - a.score);
  const best = possible[0];
  if (!best || best.score < options.minScore) return reject("score-below-minimum");

  const reasons = [
    `${options.trendTimeframe} ${direction === "buy" ? "uptrend" : "downtrend"} ${trendAtr.toFixed(2)}×ATR`,
    ...best.reasons,
    `spread ${spreadLabel(symbol, quote)}`,
    `ATR ${atrPct.toFixed(3)}%`,
    `cost ${(spreadRatio * 100).toFixed(0)}% trail`,
    ...(spread.baseline !== undefined && spread.spikeRatio !== undefined
      ? [`spread ${spread.spikeRatio.toFixed(1)}× symbol median`]
      : []),
  ];

  return {
    symbol,
    direction,
    setupType: best.setupType,
    score: best.score,
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
  /** Symbols skipped while background candle history is warming or refreshing. */
  cachePending: number;
  /** Cumulative candle API/cache failures since this screener started. */
  cacheFailures: number;
  candleFails: number;
  scored: number;
  passed: number;
  spreadRejected: number;
  spreadSpikeRejected: number;
  scoreRejects: Record<string, number>;
  /** Highest prefilter scores, useful to see why a pair reached the shortlist. */
  top: Array<{ symbol: string; prelim: number; spreadPips: number; mom5: number | null }>;
}

interface CandleCacheEntry {
  candles: NormalizedCandle[];
  /** Timeframe boundary represented by the latest completed refresh. */
  boundary: number;
  /** Avoid scheduling repeated requests inside one timeframe boundary. */
  requestedBoundary: number;
  retryAfter: number;
  loading: boolean;
}

export class Screener {
  readonly momentum = new MomentumTracker();
  lastScanAt = 0;
  lastScanDurationMs = 0;
  private readonly trendCache = new Map<string, CandleCacheEntry>();
  private readonly screenerCache = new Map<string, CandleCacheEntry>();
  private cacheFailures = 0;
  lastDiagnostics: ScanDiagnostics = {
    universe: 0,
    withQuote: 0,
    fresh: 0,
    prefiltered: 0,
    shortlist: 0,
    cachePending: 0,
    cacheFailures: 0,
    candleFails: 0,
    scored: 0,
    passed: 0,
    spreadRejected: 0,
    spreadSpikeRejected: 0,
    scoreRejects: {},
    top: [],
  };

  constructor(
    private readonly tools: Tools,
    private readonly ticks: TickHub,
    private readonly options: ScreenerOptions,
  ) {}

  observe(quote: Quote): void {
    this.momentum.observe(quote);
    observeSpread(quote);
  }

  /**
   * Return the latest cached closed candles immediately and refresh stale data
   * in the background. Candle API calls are rate-limited, so waiting for every
   * symbol serially would make the scanner slower than the market.
   */
  private cachedCandles(
    cache: Map<string, CandleCacheEntry>,
    symbol: string,
    timeframe: Timeframe,
    count: number,
    minimumCandles: number,
    now: number,
  ): NormalizedCandle[] | null {
    const duration = timeframeMs(timeframe);
    const requestedBoundary = Math.floor(now / duration) * duration;
    let entry = cache.get(symbol);
    if (!entry) {
      entry = {
        candles: [],
        boundary: -1,
        requestedBoundary: -1,
        retryAfter: 0,
        loading: false,
      };
      cache.set(symbol, entry);
    }

    if (
      !entry.loading &&
      now >= entry.retryAfter &&
      entry.requestedBoundary < requestedBoundary &&
      (entry.candles.length < minimumCandles || entry.boundary < requestedBoundary)
    ) {
      entry.loading = true;
      entry.requestedBoundary = requestedBoundary;
      void this.tools.get_candles({ symbol, timeframe, n: count })
        .then((result) => {
          const completedAt = Date.now();
          if (!result.ok) {
            this.cacheFailures += 1;
            entry!.requestedBoundary = -1;
            entry!.retryAfter = Date.now() + 5_000;
            return;
          }
          const candles = dropFormingCandle(result.data, duration, completedAt);
          if (candles.length < minimumCandles) {
            this.cacheFailures += 1;
            entry!.requestedBoundary = -1;
            entry!.retryAfter = Date.now() + 5_000;
            return;
          }
          entry!.candles = candles;
          entry!.boundary = Math.floor(completedAt / duration) * duration;
        })
        .catch(() => {
          this.cacheFailures += 1;
          entry!.requestedBoundary = -1;
          entry!.retryAfter = Date.now() + 5_000;
        })
        .finally(() => {
          entry!.loading = false;
        });
    }

    if (entry.candles.length < minimumCandles) return null;
    // Continue using a cached snapshot while refreshes are rate-limited, but
    // never keep trading a candle set that has been stale for more than two
    // timeframe boundaries.
    return now - entry.boundary <= duration * 2 ? entry.candles : null;
  }

  async scan(universe: string[]): Promise<Candidate[]> {
    const started = Date.now();
    this.lastScanAt = started;

    const now = Date.now();
    type Pre = { quote: Quote; mom5: number | null; prelim: number };
    const pre: RankedSymbol[] = [];
    let withQuote = 0;
    let fresh = 0;
    let spreadRejected = 0;
    let spreadSpikeRejected = 0;

    for (const symbol of universe) {
      const quote = this.ticks.get(symbol);
      if (!quote) continue;
      withQuote += 1;
      if (now - quote.timestamp > this.options.maxQuoteAgeMs) continue;
      fresh += 1;
      const spread = assessSpread(symbol, quote, this.options);
      if (!spread.ok) {
        spreadRejected += 1;
        if (spread.reason?.startsWith("spread spike")) spreadSpikeRejected += 1;
        continue;
      }

      const mom5 = this.momentum.changePct(symbol, 5);
      const activity = clamp(this.momentum.ticksLastMinute(symbol, now) / 120, 0, 1);
      const move = mom5 === null ? 0.35 : clamp(Math.abs(mom5) / 0.08, 0, 1);
      // Ranking is cheap and local. Only the highest-activity symbols warm
      // their candle caches, avoiding a burst of REST requests for the universe.
      const prelim =
        spreadQuality(symbol, quote, this.options) * 35 + activity * 25 + move * 40;
      pre.push({ quote, mom5, prelim });
    }

    const shortlist = selectFairShortlist(pre, this.options.shortlistSize, now);

    const candidates: Candidate[] = [];
    let candleFails = 0;
    let cachePending = 0;
    let scored = 0;
    const scoreRejects: Record<string, number> = {};
    const rejectScore = (reason: string): void => {
      scoreRejects[reason] = (scoreRejects[reason] ?? 0) + 1;
    };

    for (const entry of shortlist) {
      const symbol = entry.quote.symbol;
      const trend = this.cachedCandles(
        this.trendCache,
        symbol,
        this.options.trendTimeframe,
        260,
        210,
        now,
      );
      const screener = this.cachedCandles(
        this.screenerCache,
        symbol,
        this.options.screenerTimeframe,
        180,
        60,
        now,
      );

      if (!trend || !screener) {
        cachePending += 1;
        continue;
      }

      scored += 1;
      const candidate = scoreCandidate({
        symbol,
        screener,
        trend,
        quote: entry.quote,
        options: this.options,
        onReject: rejectScore,
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
      cachePending,
      cacheFailures: this.cacheFailures,
      candleFails,
      scored,
      passed: capped.length,
      spreadRejected,
      spreadSpikeRejected,
      scoreRejects,
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
    maxMetalSpreadPct: config.maxMetalSpreadPct,
    maxCryptoSpreadPct: config.maxCryptoSpreadPct,
    maxEnergySpreadPct: config.maxEnergySpreadPct,
    maxSpreadSpikeRatio: config.maxSpreadSpikeRatio,
    maxSpreadTrailRatio: config.maxSpreadTrailRatio,
    minAtrPct: config.minAtrPct,
    maxAtrPct: config.maxAtrPct,
    pullbackDistanceAtr: config.pullbackDistanceAtr,
    minTrendAtr: config.minTrendAtr,
    rsiMin: config.rsiMin,
    rsiMax: config.rsiMax,
    breakoutLookback: config.breakoutLookback,
    breakoutMinBodyAtr: config.breakoutMinBodyAtr,
    breakoutRsiFloor: config.breakoutRsiFloor,
    breakoutRsiCeiling: config.breakoutRsiCeiling,
    maxQuoteAgeMs: config.maxQuoteAgeMs,
    trailAtrFactor: config.trailAtrFactor,
    trailMinPips: config.trailMinPips,
  };
}
