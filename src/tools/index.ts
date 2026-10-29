import type { ExnessClient } from "../exness/client.js";
import type { CandleBidAsk, CandleHistoryResponse } from "../exness/types.js";
import { normalizeCandle, type NormalizedCandle } from "../market/candles.js";
import { isTimeframe, TIMEFRAMES, type Timeframe } from "../market/timeframes.js";
import { fail, fromToolError, ok, type ToolResult } from "./types.js";

export interface ToolContext {
  client: ExnessClient;
  accountId: string;
}

export interface Tools {
  get_candles(input: {
    symbol: string;
    timeframe: Timeframe;
    n?: number;
  }): Promise<ToolResult<NormalizedCandle[]>>;
}

const MAX_CANDLES = 1000;

export function createTools(context: ToolContext): Tools {
  const { client, accountId } = context;

  return {
    async get_candles({ symbol, timeframe, n = 100 }) {
      const instrument = symbol.toUpperCase();
      const tf = timeframe.toUpperCase();
      if (!isTimeframe(tf)) {
        return fail(
          "INVALID_TIMEFRAME",
          `Unknown timeframe "${timeframe}". Use one of: ${TIMEFRAMES.join(", ")}`,
        );
      }
      const count = Math.min(MAX_CANDLES, Math.max(1, Math.trunc(n)));
      try {
        const response = await client.get<CandleHistoryResponse>(
          `/v1/market-data/accounts/${accountId}/candles`,
          {
            query: {
              instrument,
              timeframe: tf,
              price_type: "bid",
              from: new Date().toISOString(),
              count: -count,
            },
          },
        );
        const candles = response.candles.map((candle) =>
          normalizeCandle(candle as CandleBidAsk),
        );
        return ok(candles);
      } catch (error) {
        return fromToolError(error);
      }
    },
  };
}
