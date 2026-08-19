export type TradeSide = 'BUY' | 'SELL';

export type BotState =
  | 'IDLE'
  | 'STARTING'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPING'
  | 'STOPPED'
  | 'ERROR'
  | 'EMERGENCY_STOP';

export interface MarketToken {
  id: string;
  symbol: string;
  name: string;
  address: string;
  price: number;
  marketCap: number;
  liquidity: number;
  volume24h: number;
  change1m: number;
  change5m: number;
  change15m: number;
  holders: number;
  ageSec: number;
  risk: number;
  graduated: boolean;
  watchlisted: boolean;
}

export interface Position {
  id: string;
  token: MarketToken;
  side: TradeSide;
  entry: number;
  current: number;
  sizeSol: number;
  pnl: number;
  pnlPct: number;
  stopLoss: number;
  takeProfit: number;
}

export interface ActivityItem {
  id: string;
  time: number;
  type: string;
  symbol?: string;
  detail: string;
  severity: 'info' | 'success' | 'warning' | 'error';
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}