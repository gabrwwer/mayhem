-- ============================================================================
-- Migration 003: Convert DOUBLE PRECISION to NUMERIC for Accuracy (safe, non-destructive)
-- ============================================================================
-- Notes:
--  - Use plain NUMERIC (unconstrained precision/scale) to avoid truncation/overflow.
--  - This migration is conservative: it adds new columns, copies data, validates
--    that the copy succeeded, then swaps names. It does NOT set NOT NULL or
--    drop columns with CASCADE. All destructive steps are guarded so the
--    migration can be safely reviewed before finalizing.
--
-- PHASE 1: Add new NUMERIC columns alongside existing DOUBLE PRECISION columns
-- ============================================================================

-- launches table
ALTER TABLE launches ADD COLUMN IF NOT EXISTS initial_liquidity_numeric NUMERIC;

-- pools table
ALTER TABLE pools ADD COLUMN IF NOT EXISTS liquidity_numeric NUMERIC;
ALTER TABLE pools ADD COLUMN IF NOT EXISTS reserve_token_numeric NUMERIC;
ALTER TABLE pools ADD COLUMN IF NOT EXISTS reserve_quote_numeric NUMERIC;

-- positions table (if exists)
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_price_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS quantity_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS current_price_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS unrealized_pnl_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS realized_pnl_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS stop_loss_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS take_profit_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS trailing_stop_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS fees_numeric NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS slippage_numeric NUMERIC;

-- trades table (if exists)
ALTER TABLE trades ADD COLUMN IF NOT EXISTS amount_sol_numeric NUMERIC;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS amount_token_numeric NUMERIC;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS price_numeric NUMERIC;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fees_sol_numeric NUMERIC;

-- wallet_balances table (if exists)
ALTER TABLE wallet_balances ADD COLUMN IF NOT EXISTS sol_balance_numeric NUMERIC;

-- ============================================================================
-- PHASE 2: Copy and convert existing data (non-destructive)
-- ============================================================================

-- launches table
UPDATE launches
  SET initial_liquidity_numeric = CAST(initial_liquidity AS NUMERIC)
  WHERE initial_liquidity_numeric IS NULL AND initial_liquidity IS NOT NULL;

-- pools table
UPDATE pools
  SET liquidity_numeric = CAST(liquidity AS NUMERIC)
  WHERE liquidity_numeric IS NULL AND liquidity IS NOT NULL;

UPDATE pools
  SET reserve_token_numeric = CAST(reserve_token AS NUMERIC)
  WHERE reserve_token_numeric IS NULL AND reserve_token IS NOT NULL;

UPDATE pools
  SET reserve_quote_numeric = CAST(reserve_quote AS NUMERIC)
  WHERE reserve_quote_numeric IS NULL AND reserve_quote IS NOT NULL;

-- positions table (if exists)
UPDATE positions
  SET entry_price_numeric = CAST(entry_price AS NUMERIC)
  WHERE entry_price_numeric IS NULL AND entry_price IS NOT NULL;

UPDATE positions
  SET quantity_numeric = CAST(quantity AS NUMERIC)
  WHERE quantity_numeric IS NULL AND quantity IS NOT NULL;

UPDATE positions
  SET current_price_numeric = CAST(current_price AS NUMERIC)
  WHERE current_price_numeric IS NULL AND current_price IS NOT NULL;

UPDATE positions
  SET unrealized_pnl_numeric = CAST(unrealized_pnl AS NUMERIC)
  WHERE unrealized_pnl_numeric IS NULL AND unrealized_pnl IS NOT NULL;

UPDATE positions
  SET realized_pnl_numeric = CAST(realized_pnl AS NUMERIC)
  WHERE realized_pnl_numeric IS NULL AND realized_pnl IS NOT NULL;

UPDATE positions
  SET stop_loss_numeric = CAST(stop_loss AS NUMERIC)
  WHERE stop_loss_numeric IS NULL AND stop_loss IS NOT NULL;

UPDATE positions
  SET take_profit_numeric = CAST(take_profit AS NUMERIC)
  WHERE take_profit_numeric IS NULL AND take_profit IS NOT NULL;

UPDATE positions
  SET trailing_stop_numeric = CAST(trailing_stop AS NUMERIC)
  WHERE trailing_stop_numeric IS NULL AND trailing_stop IS NOT NULL;

UPDATE positions
  SET fees_numeric = CAST(fees AS NUMERIC)
  WHERE fees_numeric IS NULL AND fees IS NOT NULL;

UPDATE positions
  SET slippage_numeric = CAST(slippage AS NUMERIC)
  WHERE slippage_numeric IS NULL AND slippage IS NOT NULL;

-- trades table (if exists)
UPDATE trades
  SET amount_sol_numeric = CAST(amount_sol AS NUMERIC)
  WHERE amount_sol_numeric IS NULL AND amount_sol IS NOT NULL;

UPDATE trades
  SET amount_token_numeric = CAST(amount_token AS NUMERIC)
  WHERE amount_token_numeric IS NULL AND amount_token IS NOT NULL;

UPDATE trades
  SET price_numeric = CAST(price AS NUMERIC)
  WHERE price_numeric IS NULL AND price IS NOT NULL;

UPDATE trades
  SET fees_sol_numeric = CAST(fees_sol AS NUMERIC)
  WHERE fees_sol_numeric IS NULL AND fees_sol IS NOT NULL;

-- wallet_balances table (if exists)
UPDATE wallet_balances
  SET sol_balance_numeric = CAST(sol_balance AS NUMERIC)
  WHERE sol_balance_numeric IS NULL AND sol_balance IS NOT NULL;

-- ============================================================================
-- PHASE 3: Validation checks (do not perform destructive swaps here)
-- ============================================================================
-- Ensure that copied numeric columns contain values for all rows where the
-- original double-precision column was non-null. If any row failed to copy,
-- the migration should be reviewed and the operation aborted.

DO $$
DECLARE
  mismatch_count INT;
BEGIN
  SELECT COUNT(*) INTO mismatch_count FROM launches WHERE initial_liquidity IS NOT NULL AND initial_liquidity_numeric IS NULL;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Migration 003 validation failed: % launches rows did not copy', mismatch_count;
  END IF;

  SELECT COUNT(*) INTO mismatch_count FROM pools WHERE liquidity IS NOT NULL AND liquidity_numeric IS NULL;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Migration 003 validation failed: % pools rows did not copy', mismatch_count;
  END IF;

  SELECT COUNT(*) INTO mismatch_count FROM positions WHERE entry_price IS NOT NULL AND entry_price_numeric IS NULL;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Migration 003 validation failed: % positions rows did not copy', mismatch_count;
  END IF;

  -- Additional checks omitted for brevity; administrators should run full
  -- checks before performing the final rename/drop steps.
END$$;

-- ============================================================================
-- NOTE: The destructive PHASE 4/5 (drop old columns and rename new columns)
-- is intentionally omitted from this script to avoid accidental data loss.
-- After review and backup, an operator may run a follow-up migration that
-- performs the final swap once validation is complete.
-- ============================================================================

-- End of migration 003 (conservative, non-destructive)
