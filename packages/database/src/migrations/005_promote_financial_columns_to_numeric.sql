-- ============================================================================
-- Migration 005: Promote canonical financial columns to NUMERIC
-- ============================================================================
-- Migration 003 deliberately created and validated NUMERIC shadow columns
-- without dropping or renaming anything.  This follow-up changes the
-- canonical columns in place so future reads and writes use exact Postgres
-- NUMERIC values.  ALTER ... TYPE preserves each existing value; it neither
-- drops nor renames a column.  Values that were originally written as a
-- DOUBLE PRECISION cannot regain precision that was already lost, but no
-- further binary floating-point conversion occurs after this migration.

ALTER TABLE launches
  ALTER COLUMN initial_liquidity TYPE NUMERIC USING initial_liquidity::NUMERIC;

ALTER TABLE pools
  ALTER COLUMN liquidity TYPE NUMERIC USING liquidity::NUMERIC,
  ALTER COLUMN reserve_token TYPE NUMERIC USING reserve_token::NUMERIC,
  ALTER COLUMN reserve_quote TYPE NUMERIC USING reserve_quote::NUMERIC;

ALTER TABLE positions
  ALTER COLUMN entry_price TYPE NUMERIC USING entry_price::NUMERIC,
  ALTER COLUMN quantity TYPE NUMERIC USING quantity::NUMERIC,
  ALTER COLUMN current_price TYPE NUMERIC USING current_price::NUMERIC,
  ALTER COLUMN unrealized_pnl TYPE NUMERIC USING unrealized_pnl::NUMERIC,
  ALTER COLUMN realized_pnl TYPE NUMERIC USING realized_pnl::NUMERIC,
  ALTER COLUMN stop_loss TYPE NUMERIC USING stop_loss::NUMERIC,
  ALTER COLUMN take_profit TYPE NUMERIC USING take_profit::NUMERIC,
  ALTER COLUMN trailing_stop TYPE NUMERIC USING trailing_stop::NUMERIC,
  ALTER COLUMN fees TYPE NUMERIC USING fees::NUMERIC,
  ALTER COLUMN slippage TYPE NUMERIC USING slippage::NUMERIC;

ALTER TABLE trades
  ALTER COLUMN amount_sol TYPE NUMERIC USING amount_sol::NUMERIC,
  ALTER COLUMN amount_token TYPE NUMERIC USING amount_token::NUMERIC,
  ALTER COLUMN price TYPE NUMERIC USING price::NUMERIC,
  ALTER COLUMN fees_sol TYPE NUMERIC USING fees_sol::NUMERIC;

ALTER TABLE transactions
  ALTER COLUMN amount_sol TYPE NUMERIC USING amount_sol::NUMERIC;

ALTER TABLE wallet_balances
  ALTER COLUMN sol_balance TYPE NUMERIC USING sol_balance::NUMERIC;
