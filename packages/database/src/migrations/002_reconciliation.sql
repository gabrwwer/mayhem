-- ============================================================================
-- Migration 002: Reconciliation Log Table
-- ============================================================================
-- Tracks order reconciliation results on startup for audit trail
-- and monitoring of orphaned orders.

-- Reconciliation audit log
CREATE TABLE IF NOT EXISTS reconciliation_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  orders_checked INT NOT NULL,
  orders_reconciled INT NOT NULL,
  bundles_in_flight JSONB,
  orphaned_positions JSONB,
  duration_ms INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_log_timestamp 
  ON reconciliation_log(timestamp DESC);

-- The runner must be able to bootstrap a completely fresh database.  The
-- durable engine-state store is used by reconciliation, so create it before
-- extending it below rather than relying on an out-of-band maintenance task.
CREATE TABLE IF NOT EXISTS engine_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Update engine_state table to track last reconciliation.
ALTER TABLE engine_state ADD COLUMN IF NOT EXISTS 
  last_reconciled_at TIMESTAMPTZ;
