/**
 * Hand-written subset of the Exness Trader API schema (trading.public.yaml v1.0.2).
 * Only the entities used by this terminal client are modelled.
 */

export type TradeMode = "enabled" | "disabled" | "close_only";
export type AccountTradingStatus = "active" | "disabled" | "close_only";
export type ExecutionMode = "market" | "instant" | "exchange";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "stop" | "limit" | "sltp";
export type OrderState = "pending_new" | "placed" | "filled" | "cancelled" | "rejected";

export interface AccountSettings {
  currency: string;
  leverage: string;
  margin_call_level?: string;
  stopout_level?: string;
  trade_mode: TradeMode;
  account_status: AccountTradingStatus;
  execution_mode: ExecutionMode;
}

export interface AccountDetails {
  account_id: string;
  account_name?: string;
  create_date: string;
  is_demo?: boolean;
  stream_id?: string;
  settings?: AccountSettings;
}

export interface AccountState {
  balance: string;
  equity: string;
  used_margin: string;
  leverage?: string;
}

export interface Position {
  position_id: string;
  direction: OrderSide;
  instrument: string;
  initial_volume?: string;
  volume: string;
  open_price?: string;
  stop_loss_price?: string | null;
  take_profit_price?: string | null;
  state: "open" | "closed";
  margin_rate?: string;
  create_time: string;
  commission?: string;
  swap?: string;
  rollover_time?: string;
}

export interface Order {
  order_id: string;
  position_id?: string;
  order_type: OrderType;
  state: OrderState;
  direction?: OrderSide;
  instrument?: string;
  price?: string;
  stop_loss_price?: string | null;
  take_profit_price?: string | null;
  create_time: string;
  update_time?: string;
  volume?: string;
  reason?: string;
}

export interface Snapshot {
  orders?: Order[];
  positions?: Position[];
  account_state: AccountState;
}

export interface CandleOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Candle extends CandleOhlc {
  time: string;
  volume: number;
}

export interface CandleBidAsk {
  time: string;
  bid: CandleOhlc;
  ask: CandleOhlc;
  volume: number;
}

export interface CandleHistoryResponse {
  candles: Array<Candle | CandleBidAsk>;
}

export interface InstrumentListResponse {
  instruments: string[];
}

export interface SwapMultiplier {
  day: string;
  multiplier: number;
}

export interface InstrumentSession {
  trade_mode: TradeMode;
  week_start_time: string;
  week_end_time: string;
}

export interface InstrumentConditions {
  instrument: string;
  description?: string;
  international_name?: string | null;
  category?: string;
  base_currency?: string;
  quote_currency?: string;
  margin_currency?: string;
  point_digits?: number;
  calc_mode?: string;
  exec_mode?: ExecutionMode;
  margin_percent?: string | null;
  contract_size?: string | null;
  volume_min?: string | null;
  volume_max?: string | null;
  volume_step?: string | null;
  swap_long?: string | null;
  swap_short?: string | null;
  swap_multipliers?: SwapMultiplier[];
  trade_mode?: TradeMode;
  order_types?: string[];
  filling_modes?: string[];
  trade_sessions?: InstrumentSession[];
}

export interface Tick {
  instrument: string;
  bid: number;
  ask: number;
  timestamp: string;
}

export interface AckResponse {
  operation_id?: string;
  client_request_id?: string;
  status: "accepted";
}

export interface OperationStatusResponse {
  operation_id: string;
  status: "pending" | "confirmed" | "rejected" | "failed";
  client_request_id?: string;
  error_code?: number;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface AccessPointResponse {
  access_point: string;
  account_id: string;
}

export interface ProfitAmount {
  amount?: string;
  currency?: string;
}

export type DealType =
  | "open"
  | "close"
  | "balance"
  | "null_compensation"
  | "swap_fee"
  | "admin_fee"
  | "dividend"
  | "exness_dollar";

export interface Deal {
  deal_id: string;
  order_id?: string;
  position_id?: string;
  type: DealType;
  direction?: OrderSide;
  instrument?: string;
  volume?: string;
  price?: string;
  profit?: ProfitAmount;
  create_time: string;
  commission?: string;
}

export interface TransactionPayload {
  orders?: Order[];
  positions?: Position[];
  deals?: Deal[];
  account_state?: AccountState;
}

export interface TransactionEvent {
  event_type: "transaction_event";
  operation_id?: string;
  client_request_id?: string;
  status?: "success" | "rejected" | "failed";
  error_code?: number;
  error_message?: string;
  event_time?: string;
  payload?: TransactionPayload;
}

export interface DealsHistoryResponse {
  items: Array<Deal | { event_time: string; deal: Deal }>;
  next_cursor?: string;
  has_more?: boolean;
}

export interface ErrorResponse {
  code?: number;
  error_message?: string;
  error_code?: string | number;
  description?: string;
}
