
// ---------------------------------------------------------------------------
// Shared domain types for the trading terminal. Zero runtime logic, safe to
// import from the UI, the API layer and the bot engine.
// ---------------------------------------------------------------------------

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'open' | 'partial' | 'filled' | 'canceled' | 'rejected';

export interface Ticker {
  coin: string;
  last: string;
  prevDay: string;
  dayHigh: string;
  dayLow: string;
  dayVolume: string;
  dayNtlVlm: string;
  timestamp: number;
}

export interface OrderBookLevel {
  px: number;
  sz: number;
  n: number;
}

export interface OrderBook {
  coin: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface Trade {
  tid: string;
  coin: string;
  px: number;
  sz: number;
  side: Side;
  time: number;
}

export interface OrderRequest {
  coin: string;
  side: Side;
  type: OrderType;
  price?: number;
  size: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
}

export interface Order extends OrderRequest {
  id: string;
  filled: number;
  status: OrderStatus;
  createdAt: number;
}

export interface Position {
  coin: string;
  side: Side;
  size: number;
  entryPx: number;
  markPx: number;
  liqPx: number;
  uPnl: number;
  roePct: number;
  leverage: number;
  updatedAt: number;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type BotMode = 'off' | 'mayhem' | 'anarchy';

export interface BotConfig {
  mode: BotMode;
  enabled: boolean;
  coin: string;
  aggressiveness: number;   // 0..1
  maxOrderSize: number;
  minOrderSize: number;
  orderRateLimit: number;   // ms between orders
  useMarketOrders: boolean;
  takeProfitPct: number;
  stopLossPct: number;
  maxOpenPositions: number;
  followTrend: boolean;
}

export interface BotLogEntry {
  at: number;
  level: 'info' | 'warn' | 'error' | 'trade';
  msg: string;
}

export interface BotState {
  running: boolean;
  mode: BotMode;
  startedAt: number | null;
  totalOrders: number;
  filledOrders: number;
  realizedPnl: number;
  lastAction: string;
  lastActionAt: number | null;
  log: BotLogEntry[];
}

export interface WsMessage {
  op?: string;
  channel: string;
  coin?: string;
  data: unknown;
  ts?: number;
}