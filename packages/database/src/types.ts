
export interface DbToken {
  id: string;
  mint_address: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: string;
  mint_authority: string | null;
  freeze_authority: string | null;
  metadata_uri: string | null;
  creator: string | null;
  created_at: Date;
}

export interface DbLaunch {
  id: string;
  token_id: string;
  platform: string;
  pool_address: string;
  quote_token: string;
  initial_liquidity: number;
  launch_time: Date;
  status: string;
}

export interface DbPool {
  id: string;
  address: string;
  token_mint: string;
  quote_mint: string;
  liquidity: number;
  reserve_token: number;
  reserve_quote: number;
  status: string;
  last_updated: Date;
}

export type TradeSide = "buy" | "sell";

export interface DbTrade {
  id: string;
  position_id: string | null;
  side: TradeSide;
  token_mint: string;
  amount_sol: number;
  amount_token: number;
  price: number;
  slippage_bps: number;
  fees_sol: number;
  tx_signature: string;
  status: string;
  created_at: Date;
}

export type PositionStatus = "open" | "closed";

export interface DbPosition {
  id: string;
  token_mint: string;
  entry_price: number;
  entry_time: Date;
  quantity: number;
  entry_tx: string;
  current_price: number;
  unrealized_pnl: number;
  realized_pnl: number;
  stop_loss: number | null;
  take_profit: number | null;
  trailing_stop: number | null;
  exit_reason: string | null;
  exit_tx: string | null;
  fees: number;
  slippage: number;
  status: PositionStatus;
  closed_at: Date | null;
}

export type TransactionStatus = "pending" | "confirmed" | "failed";

export interface DbTransaction {
  id: string;
  tx_signature: string;
  type: string;
  token_mint: string;
  amount_sol: number;
  status: TransactionStatus;
  created_at: Date;
  confirmed_at: Date | null;
}

export interface DbRiskEvent {
  id: string;
  token_mint: string;
  event_type: string;
  severity: string;
  details: Record<string, unknown>;
  created_at: Date;
}

export interface DbBotEvent {
  id: string;
  event_type: string;
  details: Record<string, unknown>;
  created_at: Date;
}

export interface DbWalletBalance {
  id: string;
  sol_balance: number;
  token_balances: Record<string, unknown>;
  updated_at: Date;
}

export interface DbAuditLog {
  id: string;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: Date;
}