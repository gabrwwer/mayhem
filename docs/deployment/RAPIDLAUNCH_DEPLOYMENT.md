# RapidLaunch.io Deployment Guide

## Overview

The Mayhem Bot can monitor tokens launched through RapidLaunch.io. The integration uses an adapter pattern, allowing the bot to operate independently of RapidLaunch while optionally connecting to its services.

## Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ RapidLaunch.io â”‚â”€â”€â”€â”€â–¶â”‚ RapidLaunchAdapter   â”‚â”€â”€â”€â”€â–¶â”‚ TokenMonitorâ”‚
â”‚ (if API exists)â”‚     â”‚ (packages/rapidlaunch â”‚     â”‚             â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â”‚  -adapter/)           â”‚     â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”˜
                       â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜            â”‚
                                                           â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ Mayhem Trading Engine (operates independently)              â”‚
â”‚ TokenDiscovery â†’ SafetyScanner â†’ RiskEngine â†’ Execution    â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

## Deployment Steps

### 1. Build the Project

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

### 3. Connect Solana RPC

Set a reliable RPC endpoint (Helius, QuickNode, Triton, etc.):
```
SOLANA_RPC_URL=https://your-rpc-endpoint.com
SOLANA_BACKUP_RPC_URL=https://your-backup-rpc.com
```

### 4. Configure Wallet

For development (encrypted local wallet):
```bash
# The bot will prompt for a password on first run to create wallet.enc
WALLET_PROVIDER=encrypted_local
```

For production, implement the `ExternalSignerWallet` interface to connect to your HSM or hardware wallet.

### 5. Configure RapidLaunch Adapter

**Important**: The RapidLaunch adapter endpoints are placeholders. Before configuring:

1. Check if RapidLaunch.io provides a public API or SDK.
2. If an API exists, update `packages/rapidlaunch-adapter/src/adapter.ts` with the documented endpoints.
3. If no API exists, the bot will operate independently using on-chain Solana data.

If RapidLaunch provides an API:
```
RAPIDLAUNCH_API_URL=https://api.rapidlaunch.io  # Replace with actual URL
RAPIDLAUNCH_API_KEY=your-api-key                # If required
```

### 6. Test in DRY_RUN Mode

```bash
DRY_RUN=true
TRADING_ENABLED=false
npm run dev:bot
```

Verify:
- Bot starts without errors
- Token discovery is working (check logs for discovered tokens)
- No real transactions are attempted

### 7. Verify Token Discovery

Check the dashboard or API:
```bash
curl http://localhost:3001/api/tokens
curl http://localhost:3001/api/launches
```

### 8. Verify Transaction Simulation

Enable trading in dry-run mode:
```
DRY_RUN=true
TRADING_ENABLED=true
```

The bot will simulate trades without blockchain interaction. Check:
```bash
curl http://localhost:3001/api/positions
curl http://localhost:3001/api/trades
```

### 9. Start the Dashboard

```bash
npm run dev:dashboard
# Open http://localhost:3000
```

### 10. Enable Live Trading

**Only after all verification steps pass:**

```
DRY_RUN=false
TRADING_ENABLED=true
```

Restart the bot. Verify:
- Transaction simulation occurs before every trade
- Positions appear with real transaction signatures
- Stop-loss and take-profit triggers work correctly

## RapidLaunch Integration Requirements

The following information is required from RapidLaunch.io to enable full integration:

| Requirement | Status | Notes |
|-------------|--------|-------|
| API base URL | **Required** | Set as RAPIDLAUNCH_API_URL |
| API authentication method | **Required** | API key, OAuth, or other |
| Token launch event endpoint | **Required** | For real-time launch detection |
| Token metadata endpoint | Optional | Falls back to on-chain data |
| Pool/liquidity endpoint | Optional | Falls back to on-chain data |
| WebSocket/webhook support | Optional | For real-time event streaming |
| Rate limits | **Required** | To configure polling intervals |
| SDK availability | Optional | Could replace HTTP adapter |

## Running Without RapidLaunch

The bot operates fully without RapidLaunch by monitoring on-chain Solana activity:
- Subscribes to Token Program logs for new mint detection
- Polls known DEX programs for new pool creation
- Fetches token metadata from on-chain accounts

Set `RAPIDLAUNCH_API_URL=` (empty) to disable the adapter.

## Docker Deployment

```bash
docker compose up -d
```

This starts: PostgreSQL, Redis, bot, API, and dashboard.

## Monitoring

- Dashboard: http://localhost:3000
- API health: http://localhost:3001/health
- Bot logs: `docker compose logs -f bot`

## Emergency Procedures

1. **Emergency stop via API**: `curl -X POST http://localhost:3001/api/emergency-stop -H "Authorization: Bearer YOUR_TOKEN"`
2. **Emergency stop via dashboard**: Click the red "Emergency Stop" button.
3. **Kill the bot**: `docker compose stop bot`