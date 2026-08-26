
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

// NOTE: Financial fields are represented as strings to preserve exact
// NUMERIC values from Postgres and to interoperate with Decimal.js based
// arithmetic in other packages. Using `number` would lose precision.
export interface DbLaunch {
  id: string;
  token_id: string;
  platform: string;
  pool_address: string;
  quote_token: string;
  initial_liquidity: string; // NUMERIC as string
  launch_time: Date;
  status: string;
}

export interface DbPool {
  id: string;
  address: string;
  token_mint: string;
  quote_mint: string;
  liquidity: string; // NUMERIC as string
  reserve_token: string; // NUMERIC as string
  reserve_quote: string; // NUMERIC as string
  status: string;
  last_updated: Date;
}

export type TradeSide = "buy" | "sell";

export interface DbTrade {
  id: string;
  position_id: string | null;
  side: TradeSide;
  token_mint: string;
  amount_sol: string; // NUMERIC as string
  amount_token: string; // NUMERIC as string
  price: string; // NUMERIC as string
  slippage_bps: number;
  fees_sol: string; // NUMERIC as string
  tx_signature: string;
  status: string;
  created_at: Date;
}

export type PositionStatus = "open" | "closed";

export interface DbPosition {
  id: string;
  token_mint: string;
  entry_price: string; // NUMERIC as string
  entry_time: Date;
  quantity: string; // NUMERIC as string
  entry_tx: string;
  current_price: string; // NUMERIC as string
  unrealized_pnl: string; // NUMERIC as string
  realized_pnl: string; // NUMERIC as string
  stop_loss: string | null; // NUMERIC as string
  take_profit: string | null; // NUMERIC as string
  trailing_stop: string | null; // NUMERIC as string
  exit_reason: string | null;
  exit_tx: string | null;
  fees: string; // NUMERIC as string
  slippage: string; // NUMERIC as string
  status: PositionStatus;
  closed_at: Date | null;
}

export type TransactionStatus = "pending" | "confirmed" | "failed";

export interface DbTransaction {
  id: string;
  tx_signature: string;
  type: string;
  token_mint: string;
  amount_sol: string; // NUMERIC as string
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
  sol_balance: string; // NUMERIC as string
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