/** Timeframe tokens accepted by GET /v1/market-data/.../candles. */
export const TIMEFRAMES = [
  "S1",
  "S5",
  "S15",
  "M1",
  "M3",
  "M5",
  "M10",
  "M15",
  "M30",
  "H1",
  "H2",
  "H4",
  "D1",
  "W1",
  "MN",
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

/** Duration of one candle for each supported timeframe, in milliseconds. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  S1: 1_000,
  S5: 5_000,
  S15: 15_000,
  M1: 60_000,
  M3: 180_000,
  M5: 300_000,
  M10: 600_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H2: 7_200_000,
  H4: 14_400_000,
  D1: 86_400_000,
  W1: 604_800_000,
  MN: 2_592_000_000,
};

export function timeframeMs(timeframe: Timeframe): number {
  return TIMEFRAME_MS[timeframe];
}

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}
