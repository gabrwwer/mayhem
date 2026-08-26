-- ============================================================================
-- Migration 004: Wallet Key Version History Tracking
-- ============================================================================
-- Track key rotations for compromise recovery and audit trail

-- Wallet key version history
CREATE TABLE IF NOT EXISTS wallet_key_versions (
  id SERIAL PRIMARY KEY,
  version INT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  dual_sign_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  backup_path TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_wallet_versions_status 
  ON wallet_key_versions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_versions_public_key
  ON wallet_key_versions(public_key);

-- Track who rotated and when
CREATE TABLE IF NOT EXISTS wallet_rotation_events (
  id SERIAL PRIMARY KEY,
  from_version INT NOT NULL REFERENCES wallet_key_versions(version),
  to_version INT NOT NULL REFERENCES wallet_key_versions(version),
  reason VARCHAR(255),
  initiated_by TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dual_sign_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rotation_events_timestamp
  ON wallet_rotation_events(completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_rotation_events_versions
  ON wallet_rotation_events(from_version, to_version);
