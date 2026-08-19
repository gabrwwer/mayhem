
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mint_address VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(256) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    decimals INTEGER NOT NULL,
    supply VARCHAR(64) NOT NULL,
    mint_authority VARCHAR(64),
    freeze_authority VARCHAR(64),
    metadata_uri TEXT,
    creator VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tokens_mint_address ON tokens (mint_address);
CREATE INDEX idx_tokens_creator ON tokens (creator);
CREATE INDEX idx_tokens_symbol ON tokens (symbol);

CREATE TABLE launches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id UUID NOT NULL REFERENCES tokens(id),
    platform VARCHAR(64) NOT NULL,
    pool_address VARCHAR(64) NOT NULL,
    quote_token VARCHAR(64) NOT NULL,
    initial_liquidity DOUBLE PRECISION NOT NULL,
    launch_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'detected'
);

CREATE INDEX idx_launches_token_id ON launches (token_id);
CREATE INDEX idx_launches_platform ON launches (platform);
CREATE INDEX idx_launches_status ON launches (status);
CREATE INDEX idx_launches_launch_time ON launches (launch_time);

CREATE TABLE pools (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(64) NOT NULL UNIQUE,
    token_mint VARCHAR(64) NOT NULL,
    quote_mint VARCHAR(64) NOT NULL,
    liquidity DOUBLE PRECISION NOT NULL DEFAULT 0,
    reserve_token DOUBLE PRECISION NOT NULL DEFAULT 0,
    reserve_quote DOUBLE PRECISION NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pools_address ON pools (address);
CREATE INDEX idx_pools_token_mint ON pools (token_mint);
CREATE INDEX idx_pools_status ON pools (status);

CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_mint VARCHAR(64) NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    quantity DOUBLE PRECISION NOT NULL,
    entry_tx VARCHAR(128) NOT NULL,
    current_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    unrealized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    stop_loss DOUBLE PRECISION,
    take_profit DOUBLE PRECISION,
    trailing_stop DOUBLE PRECISION,
    exit_reason VARCHAR(64),
    exit_tx VARCHAR(128),
    fees DOUBLE PRECISION NOT NULL DEFAULT 0,
    slippage DOUBLE PRECISION NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    closed_at TIMESTAMPTZ
);

CREATE INDEX idx_positions_token_mint ON positions (token_mint);
CREATE INDEX idx_positions_status ON positions (status);
CREATE INDEX idx_positions_entry_time ON positions (entry_time);

CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    position_id UUID REFERENCES positions(id),
    side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
    token_mint VARCHAR(64) NOT NULL,
    amount_sol DOUBLE PRECISION NOT NULL,
    amount_token DOUBLE PRECISION NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    slippage_bps INTEGER NOT NULL DEFAULT 0,
    fees_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
    tx_signature VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trades_position_id ON trades (position_id);
CREATE INDEX idx_trades_token_mint ON trades (token_mint);
CREATE INDEX idx_trades_tx_signature ON trades (tx_signature);
CREATE INDEX idx_trades_created_at ON trades (created_at);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tx_signature VARCHAR(128) NOT NULL UNIQUE,
    type VARCHAR(32) NOT NULL,
    token_mint VARCHAR(64) NOT NULL,
    amount_sol DOUBLE PRECISION NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ
);

CREATE INDEX idx_transactions_tx_signature ON transactions (tx_signature);
CREATE INDEX idx_transactions_token_mint ON transactions (token_mint);
CREATE INDEX idx_transactions_status ON transactions (status);

CREATE TABLE risk_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_mint VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_risk_events_token_mint ON risk_events (token_mint);
CREATE INDEX idx_risk_events_severity ON risk_events (severity);
CREATE INDEX idx_risk_events_created_at ON risk_events (created_at);

CREATE TABLE bot_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(64) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_events_event_type ON bot_events (event_type);
CREATE INDEX idx_bot_events_created_at ON bot_events (created_at);

CREATE TABLE wallet_balances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sol_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
    token_balances JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallet_balances_updated_at ON wallet_balances (updated_at);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action VARCHAR(128) NOT NULL,
    actor VARCHAR(128) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_action ON audit_logs (action);
CREATE INDEX idx_audit_logs_actor ON audit_logs (actor);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);