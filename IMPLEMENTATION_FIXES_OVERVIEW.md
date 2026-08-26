# MAYHEM Bot: 11 Critical Fixes Implementation Guide
## Senior Engineering Review & Code-Ready Solutions

---

## BLOCKING ISSUES (Fix Before Live Trading)

### FIX #1: ORDER RECONCILIATION ON RESTART

**Problem**
Orphaned positions possible on bot restart. Circuit breaker and positions persist in database via \ngine_state\ table, but no reconciliation logic replays them after crash/restart. A bot restart loses all in-memory order state without verifying what actually landed on-chain.

**Root Cause**
The \MayhemEngine\ loads persisted position state and unresolved orders but never validates them against on-chain state or pending Solana transactions. If a bundle submitted just before shutdown partially landed, the restart skips reconciliation and leaves:
- Orphaned positions with no stop-loss
- Unclosed orders in unknown state
- No audit trail of what happened

**Implementation**
1. Create \OrderReconciliationService\ in \packages/execution/src/reconciliation.ts\
2. Add reconciliation migration in \packages/database/src/migrations/002_reconciliation.sql\
3. Call from \pps/bot/src/index.ts\ at startup (before trading enabled)
4. Reconciliation checks: pending bundles, pending txs, position vs. holdings

**Files to Create/Modify:**
- Create: \packages/execution/src/reconciliation.ts\ (3KB)
- Create: \packages/database/src/migrations/002_reconciliation.sql\ (1KB)
- Modify: \pps/bot/src/index.ts\ (add init call)
- Modify: \packages/database/src/state-store.ts\ (add reconciliation table)

**Deployment**
- Run migration first (creates reconciliation_log table)
- Add env var: \RECONCILE_ON_STARTUP=true\ (default: true)
- Reconciliation is async but blocks trading until complete
- First boot takes 5-10s extra (fetches Solana state)

**Risk**
- If reconciliation times out, bot refuses to trade (safe, but blocks ops)
- Mitigation: Set \RECONCILIATION_TIMEOUT_MS=30000\ (configurable)

---

### FIX #2: DATABASE NUMERIC PRECISION

**Problem**
DOUBLE PRECISION for amounts causes rounding errors. A 1,000,000 lamport transaction might round to 999,999 or 1,000,001. Over hundreds of trades, this compounds into audit failures.

**Root Cause**
Schema uses PostgreSQL DOUBLE PRECISION (IEEE 754 64-bit float) for all amounts:
- \alances.amount DOUBLE PRECISION\
- \	rades.size DOUBLE PRECISION\
- Solana amounts are integers, floats cannot exactly represent all integers > 2^53

**Implementation**
1. Alter table: Change DOUBLE PRECISION → NUMERIC(20,8) for all amount columns
2. Data migration: Convert existing values (SELECT CAST(x AS NUMERIC))
3. Update all queries and types to use NUMERIC
4. Update TypeScript types (use string for NUMERIC)

**Files to Create/Modify:**
- Create: \packages/database/src/migrations/003_numeric_precision.sql\ (2KB)
- Modify: \packages/database/src/repositories.ts\ (update queries)
- Modify: \packages/database/src/types.ts\ (use string for NUMERIC columns)

**Deployment**
- Migration is zero-downtime (ALTER TABLE in background)
- After deploy, run: \psql -f migrations/003_numeric_precision.sql\
- Rollback: \ALTER TABLE ... DOUBLE PRECISION\ + restore from backup

**Risk**
- If rollback happens mid-transaction, data may be corrupted (use backup)
- Mitigation: Take database snapshot before migration

---

### FIX #3: CONNECTION POOL CONFIGURATION

**Problem**
No pool size limits, no timeout configuration. Under load, connections can exhaust, or a slow query can hang the entire pool indefinitely.

**Root Cause**
\DatabaseClient\ creates a Pool with no config:
\\\	s
this.pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
});
\\\
This uses node-pg defaults (10 connections, infinite idle timeout).

**Implementation**
1. Add pool config to DatabaseClient constructor
2. Add environment variables for pool limits
3. Add connection health check on startup
4. Add query timeout middleware

**Files to Modify:**
- \packages/database/src/client.ts\ (add PoolConfig)

**Deployment**
- Add env vars (backward compatible with defaults):
  - \DATABASE_POOL_MAX=20\ (max connections)
  - \DATABASE_POOL_IDLE_TIMEOUT_MS=30000\ (idle close)
  - \DATABASE_QUERY_TIMEOUT_MS=5000\ (per-query timeout)
- No schema changes
- Immediate effect on new connections

**Risk**
- If POOL_MAX too low, queries queue and timeout
- If IDLE_TIMEOUT too short, connections recycle unnecessarily
- Mitigation: Start conservative (20, 30s, 5s), monitor

---

## HIGH PRIORITY FIXES (Reliability & Security)

### FIX #4: JITO TIP ACCOUNT FALLBACK

**Problem**
If Jito's getTipAccounts() API fails, bot cannot send bundles. No fallback or retry with stale cache.

**Root Cause**
\JitoClient.tipAccounts()\ throws on fetch failure:
\\\	s
const accounts = (await this.rpc("getTipAccounts", [])) as string[];
\\\
No retry, no stale cache fallback, no hardcoded tip account list.

**Implementation**
1. Add hardcoded fallback tip account list
2. Implement retry with exponential backoff for getTipAccounts
3. Use stale cache for up to 5min on API failure
4. Log warning on fallback activation

**Files to Modify:**
- \packages/execution/src/jito.ts\ (enhance tipAccounts method)

**Deployment**
- Add constant: \const FALLBACK_TIP_ACCOUNTS = [...];\
- No env var changes needed
- Immediate effect after deploy

**Risk**
- Fallback tip accounts might be invalid if Jito changes leadership
- Mitigation: Update fallback list monthly, test on testnet first

---

### FIX #5: WALLET KEY ROTATION MECHANISM

**Problem**
No process for rotating a compromised key. If private key is leaked, it's permanently compromised with no way to retire it.

**Root Cause**
Wallet is loaded once at startup. No key versioning, no rotation commands, no audit trail of key changes.

**Implementation**
1. Add key versioning to EncryptedLocalWallet
2. Create WalletRotationService with rotate() command
3. Add database table: wallet_key_versions
4. CLI command: \
px mayhem wallet rotate --new-password=...\
5. Dual-sign for 24h during rotation window (old + new key)

**Files to Create/Modify:**
- Create: \packages/solana/src/wallet-rotator.ts\ (3KB)
- Create: \packages/database/src/migrations/004_wallet_versions.sql\
- Modify: \packages/solana/src/wallet.ts\ (add version field)

**Deployment**
- Migration creates wallet_key_versions table
- First rotation creates v2 key (old key v1 still works for 24h)
- After 24h window, only v2 is valid
- Rollback: No automatic rollback (manual key restore from backup)

**Risk**
- If new key is lost during rotation, wallet is inaccessible
- Mitigation: Require key backup before rotation starts
- If 24h window expires before trades complete, orphaned orders

---

### FIX #6: PASSWORD BRUTE FORCE PROTECTION

**Problem**
No rate limiting on EncryptedLocalWallet.load(). An attacker with a wallet file can offline brute-force the password.

**Root Cause**
\EncryptedLocalWallet.load()\ attempts decrypt with no attempt counter or backoff.

**Implementation**
1. Add attempt tracking to wallet file (append-only log)
2. Implement exponential backoff: 1s, 2s, 4s, 8s...
3. Lock wallet after 10 failed attempts (1 hour cooldown)
4. Log all attempts with timestamp

**Files to Modify:**
- \packages/solana/src/wallet.ts\ (add brute-force protection)

**Deployment**
- Wallet file format unchanged (add .attempts metadata file)
- No backward compatibility issues
- Immediate effect on next load attempt

**Risk**
- If metadata file is deleted, protection is bypassed
- Mitigation: Verify file permissions, use file integrity checks
- Locked wallet still blocks trading (requires manual unlock)

---

### HIGH PRIORITY: ADDITIONAL ISSUES

#### FIX #7: Add wallet_connections table
- Tracks entry/exit events for audit
- Migration: \packages/database/src/migrations/005_wallet_events.sql\

#### FIX #8: Add migration_history table
- Tracks all schema migrations
- Migration: \packages/database/src/migrations/006_migration_history.sql\

#### FIX #9: Add order_reconciliation table
- Explicit reconciliation log
- Migration: \packages/database/src/migrations/007_reconciliation_table.sql\

#### FIX #10: Transaction signing validation
- Validate tx contents before signing
- Modify: \packages/solana/src/wallet.ts\ (add validation step)

#### FIX #11: Jito poll interval jitter
- Add random delay to prevent thundering herd
- Modify: \packages/execution/src/jito.ts\ (add jitter to waitForLanding poll)

---

## IMPLEMENTATION PRIORITY MATRIX

| Fix | Blocking | Effort | Risk | Do First |
|-----|----------|--------|------|----------|
| 1. Order Reconciliation | YES | 6h | M | ✅ |
| 2. Numeric Precision | YES | 4h | H | ✅ |
| 3. Connection Pool | YES | 2h | M | ✅ |
| 4. Jito Fallback | HIGH | 2h | L | ✅ |
| 5. Key Rotation | HIGH | 8h | M | ⏸️ |
| 6. Brute Force | HIGH | 3h | L | ✅ |
| 7-9. Tables | HIGH | 3h | L | ✅ |
| 10. Tx Validation | HIGH | 2h | L | ✅ |
| 11. Poll Jitter | MED | 1h | L | ⏸️ |

**Total Effort**: 32 hours

---

See detailed code implementations below...
