# Security Documentation - Mayhem Bot

## Threat Model

### Assets
- **Wallet private keys**: The most critical asset. Compromise leads to total fund loss.
- **SOL and token balances**: Funds controlled by the bot's wallet.
- **Trading configuration**: Strategies, thresholds, and position data.
- **API access**: Control over bot operations.

### Attack Surfaces

| Surface | Threat | Mitigation |
|---------|--------|------------|
| Wallet key storage | Key extraction | AES-256-GCM encryption with PBKDF2 key derivation (600k iterations). Keys never stored in plaintext. |
| Environment variables | Secret leakage | `.env` excluded from git. `WALLET_SECRET` only for testing. Production uses encrypted local or HSM. |
| API endpoints | Unauthorized control | Bearer token auth on all control endpoints. Emergency stop requires authentication. |
| Logging | Secret leakage | Logger filters any key containing 'secret', 'key', 'password', 'private'. |
| Database | Position data tampering | Connection via authenticated PostgreSQL. No private keys stored in database. |
| RPC communication | Man-in-the-middle | Use HTTPS RPC endpoints. Validate transaction simulation before signing. |
| Dependencies | Supply chain attack | Lock file pinning. Minimal dependency surface. |

### Wallet Security Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ WalletProvider Interface                â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚ EncryptedLocalWallet (development)      â”‚
â”‚ - AES-256-GCM encryption               â”‚
â”‚ - PBKDF2 key derivation (600k rounds)  â”‚
â”‚ - Encrypted file storage (wallet.enc)  â”‚
â”‚ - Decrypted only in-memory             â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚ EnvSecretWallet (testing ONLY)          â”‚
â”‚ - Reads base58 from WALLET_SECRET env  â”‚
â”‚ - Logs security warning on creation    â”‚
â”‚ - NEVER use in production              â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚ ExternalSignerWallet (production)       â”‚
â”‚ - HSM/hardware wallet integration      â”‚
â”‚ - Transaction sent to external signer  â”‚
â”‚ - Private key never touches the bot    â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

### What the Bot NEVER Does
- Stores private keys in the database
- Sends private keys to any API or external service
- Logs private keys or seed phrases
- Exposes private keys through REST endpoints
- Includes private keys in Git
- Creates hidden or undisclosed transactions
- Bypasses wallet authorization
- Manipulates reported balances or P/L
- Fakes trading volume
- Installs persistence mechanisms beyond its own service
- Exfiltrates data to unauthorized destinations

### Transaction Safety
1. Every transaction is **simulated** before signing (even in live mode).
2. Transaction simulation failure prevents signing and sending.
3. All transactions are logged with signatures for audit.
4. DRY_RUN mode prevents any blockchain interaction.
5. Emergency stop immediately halts all trading.
6. Risk engine validates every trade before execution.

### Configuration Safety
- `DRY_RUN=true` by default - no real transactions possible.
- `TRADING_ENABLED=false` by default - bot runs in monitor-only mode.
- Both must be explicitly changed to enable live trading.
- Emergency stop overrides all configuration.

### Incident Response
1. **Suspected key compromise**: Trigger emergency stop, transfer funds from compromised wallet immediately using a different tool.
2. **Unexpected transactions**: Check audit logs, verify transaction signatures on-chain, trigger emergency stop.
3. **API breach**: Rotate API_AUTH_TOKEN, review access logs, trigger emergency stop.

### Audit Trail
All actions are recorded in the `audit_logs` database table:
- Bot start/stop events
- Configuration changes
- Trade executions
- Emergency stop activations
- Risk engine overrides