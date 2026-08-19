# Mayhem Bot

Automated Solana token launch monitoring and trading bot with configurable risk management, safety scanning, and paper trading simulation.

## Features

- **Token Discovery**: Real-time monitoring of new Solana token launches
- **Safety Scanner**: Multi-factor token risk assessment (mint/freeze authority, liquidity, holder concentration)
- **Risk Engine**: Position limits, daily loss caps, exposure checks, emergency stop
- **Trading Engine**: Configurable TP/SL, trailing stops, time-based exits, liquidity-based exits
- **Paper Trading**: Full simulation mode with realistic price modeling
- **Anti-Rug Protection**: Continuous liquidity monitoring with automatic emergency exits
- **Dashboard**: Real-time web dashboard for monitoring and control
- **RapidLaunch Adapter**: Optional integration with RapidLaunch.io (adapter pattern)

## Safety Defaults

The bot ships with safe defaults â€” **no real trading is possible** without explicit configuration:

```
DRY_RUN=true          # No blockchain transactions
TRADING_ENABLED=false  # Monitor-only mode
```

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 16+ (or use Docker)
- Redis 7+ (or use Docker)

### Installation

```bash
pnpm install --frozen-lockfile
```

### Configure

```bash
cp .env.example .env
# Edit .env â€” at minimum set SOLANA_RPC_URL
```

### Start with Docker (recommended)

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, bot, API, and dashboard.

### Start without Docker

```bash
# Terminal 1: Start the bot
pnpm run dev:bot

# Terminal 2: Start the API
pnpm run dev:api

# Terminal 3: Start the dashboard
pnpm run dev:dashboard
```

### Access

- Dashboard: http://localhost:3000
- API: http://localhost:3001
- Health check: http://localhost:3001/health

## Testing

```bash
# All tests
pnpm test

# Unit tests only
pnpm run test:unit

# Integration tests only
pnpm run test:integration
```

No test spends real SOL. All tests use mocked RPC connections and simulated execution.

## Simulation Mode

Run the bot in simulation mode to test strategies without risk:

```bash
DRY_RUN=true
TRADING_ENABLED=true
```

The simulation engine models:
- Realistic price movements (geometric Brownian motion)
- Slippage and priority fees
- Transaction failures
- TP/SL/trailing stop triggers

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| DRY_RUN | true | Paper trading mode |
| TRADING_ENABLED | false | Enable/disable trading |
| MAX_POSITION_SOL | 0.05 | Max SOL per position |
| MAX_OPEN_POSITIONS | 3 | Max simultaneous positions |
| TAKE_PROFIT_PERCENT | 20 | Take profit threshold |
| STOP_LOSS_PERCENT | 10 | Stop loss threshold |
| TRAILING_STOP_PERCENT | 8 | Trailing stop distance |
| MAX_HOLD_SECONDS | 300 | Max position hold time |
| MIN_LIQUIDITY_SOL | 5 | Min pool liquidity |
| SLIPPAGE_BPS | 100 | Max slippage (basis points) |
| PRIORITY_FEE_LAMPORTS | 100000 | Transaction priority fee |

See `.env.example` for the complete list.

## Enabling Live Trading

1. Complete all testing in DRY_RUN mode
2. Verify token discovery works
3. Verify transaction simulation passes
4. Verify dashboard displays correct data
5. Set `DRY_RUN=false` and `TRADING_ENABLED=true`
6. Restart the bot
7. Monitor via dashboard

**Every trade in live mode is simulated before signing.** If simulation fails, the trade is rejected.

## RapidLaunch Integration

See [docs/RAPIDLAUNCH_DEPLOYMENT.md](docs/RAPIDLAUNCH_DEPLOYMENT.md).

The bot works independently of RapidLaunch. The adapter is optional and requires RapidLaunch to provide a documented API. If no API is available, the bot monitors tokens directly on-chain.

**Information required from RapidLaunch.io:**
- API base URL and authentication method
- Token launch event endpoint or webhook
- Rate limit documentation

## Architecture

```
root/
â”œâ”€â”€ apps/
â”‚   â”œâ”€â”€ bot/          # Main trading bot process
â”‚   â”œâ”€â”€ api/          # REST API for dashboard and control
â”‚   â””â”€â”€ dashboard/    # Web dashboard
â”œâ”€â”€ packages/
â”‚   â”œâ”€â”€ config/       # Zod-validated configuration
â”‚   â”œâ”€â”€ database/     # PostgreSQL client and repositories
â”‚   â”œâ”€â”€ solana/       # Solana connection and wallet management
â”‚   â”œâ”€â”€ trading-engine/  # Position management and exit conditions
â”‚   â”œâ”€â”€ risk-engine/     # Risk assessment and safety scanning
â”‚   â”œâ”€â”€ token-monitor/   # Token discovery providers
â”‚   â”œâ”€â”€ rapidlaunch-adapter/  # RapidLaunch.io integration
â”‚   â””â”€â”€ execution/       # Transaction building and sending
â”œâ”€â”€ tests/
â”œâ”€â”€ docs/
â””â”€â”€ docker/
```

## Security

See [SECURITY.md](SECURITY.md) for the full threat model.

Key points:
- Private keys are **never** stored in plaintext, logged, or transmitted
- Wallet encryption uses AES-256-GCM with PBKDF2 (600k iterations)
- Production should use the ExternalSignerWallet (HSM/hardware wallet)
- All control API endpoints require authentication
- Emergency stop is always available

## Troubleshooting

**Bot won't start**: Check `SOLANA_RPC_URL` is set and reachable.

**No tokens discovered**: Verify RPC supports WebSocket subscriptions. Some public RPCs limit subscriptions.

**Trades not executing**: Check both `DRY_RUN=false` AND `TRADING_ENABLED=true`. Check risk engine logs for rejected trades.

**Emergency stop won't clear**: Set `TRADING_ENABLED=false`, restart the bot, then re-enable.

**Database connection fails**: Verify `DATABASE_URL` and that PostgreSQL is running. The bot can operate without a database in dry-run mode (positions are in-memory only).