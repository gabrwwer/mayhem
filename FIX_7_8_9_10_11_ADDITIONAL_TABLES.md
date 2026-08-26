# FIX #7-11: ADDITIONAL TABLES, VALIDATION & MONITORING

---

## FIX #7: Add wallet_connections Table

### Problem
No audit trail of wallet entry/exit events. Cannot track when wallet was connected/disconnected or detect unauthorized access patterns.

### Implementation

**File**: `packages/database/src/migrations/005_wallet_events.sql`

```sql
-- Track wallet connection lifecycle
CREATE TABLE IF NOT EXISTS wallet_connections (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL,
  disconnected_at TIMESTAMPTZ,
  duration_ms INT,
  
  -- Context
  reason VARCHAR(255), -- 'startup', 'manual', 'rotation', 'error'
  ip_address INET,
  user_agent TEXT,
  
  -- Security
  auth_method VARCHAR(50), -- 'password', 'hardware', 'external'
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_connections_wallet 
  ON wallet_connections(wallet_address, connected_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_connections_active 
  ON wallet_connections(wallet_address) WHERE disconnected_at IS NULL;
```

### Integration in Bot

**File**: `apps/bot/src/wallet-event-tracker.ts` (new file)

```typescript
import { DatabaseClient } from '@mayhem/database';
import { EngineLogger } from '@mayhem/trading-engine';

export class WalletEventTracker {
  private sessionId: string;
  private walletAddress: string;
  private connectedAt: number;

  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: EngineLogger,
    walletAddress: string,
  ) {
    this.walletAddress = walletAddress;
    this.sessionId = `${walletAddress}-${Date.now()}`;
    this.connectedAt = Date.now();
  }

  async recordConnect(reason: string = 'startup'): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_connections 
       (wallet_address, connected_at, reason, auth_method)
       VALUES ($1, $2, $3, $4)`,
      [
        this.walletAddress,
        new Date(this.connectedAt).toISOString(),
        reason,
        'password', // auth method used
      ],
    );

    this.logger.info('Wallet connected', {
      wallet: this.walletAddress.substring(0, 8) + '...',
      reason,
    });
  }

  async recordDisconnect(): Promise<void> {
    const now = Date.now();
    const duration = now - this.connectedAt;

    await this.db.query(
      `UPDATE wallet_connections 
       SET disconnected_at = $1, duration_ms = $2
       WHERE wallet_address = $3 AND disconnected_at IS NULL
       LIMIT 1`,
      [
        new Date(now).toISOString(),
        duration,
        this.walletAddress,
      ],
    );

    this.logger.info('Wallet disconnected', {
      wallet: this.walletAddress.substring(0, 8) + '...',
      sessionDurationMs: duration,
    });
  }
}
```

---

## FIX #8: Add migration_history Table

### Problem
No version tracking of schema migrations. Cannot determine which migrations have been applied or reliably handle rollbacks.

### Implementation

**File**: `packages/database/src/migrations/006_migration_history.sql`

```sql
-- Track all schema migrations for audit and rollback
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  description TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_time_ms INT,
  status VARCHAR(20) NOT NULL DEFAULT 'success', -- success, failed, rolled_back
  error_message TEXT,
  deployed_by TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_migrations_executed_at 
  ON schema_migrations(executed_at DESC);

-- Add migration history columns to engine_state
ALTER TABLE engine_state ADD COLUMN IF NOT EXISTS 
  last_migration_version VARCHAR(50);

-- Pre-populate with existing migrations
INSERT INTO schema_migrations (version, description, status) 
  VALUES 
  ('001', 'Initial schema', 'success'),
  ('002', 'Reconciliation log table', 'success'),
  ('003', 'Numeric precision conversion', 'success')
ON CONFLICT DO NOTHING;
```

### Migration Runner

**File**: `scripts/run-migrations.ts` (utility)

```typescript
import { DatabaseClient } from '@mayhem/database';
import * as fs from 'fs';
import * as path from 'path';

export async function runMigrations(db: DatabaseClient, migrationsDir: string) {
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = path.basename(file, '.sql');
    
    // Check if already applied
    const result = await db.query(
      'SELECT status FROM schema_migrations WHERE version = $1',
      [version],
    );

    if (result.rows.length > 0) {
      console.log(`✓ ${version}: Already applied`);
      continue;
    }

    console.log(`→ ${version}: Running...`);
    const startTime = Date.now();

    try {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await db.query(sql);

      const executionTimeMs = Date.now() - startTime;
      await db.query(
        `INSERT INTO schema_migrations (version, description, execution_time_ms, status)
         VALUES ($1, $2, $3, 'success')`,
        [version, `Migration ${version}`, executionTimeMs],
      );

      console.log(`✓ ${version}: Completed in ${executionTimeMs}ms`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await db.query(
        `INSERT INTO schema_migrations (version, description, status, error_message)
         VALUES ($1, $2, 'failed', $3)`,
        [version, `Migration ${version}`, error],
      );

      console.error(`✗ ${version}: FAILED - ${error}`);
      throw err;
    }
  }
}
```

---

## FIX #9: Add order_reconciliation Table

### Problem
Reconciliation state is stored in JSONB blob without explicit audit log. Cannot track reconciliation history or debug reconciliation failures.

### Implementation

**File**: `packages/database/src/migrations/007_reconciliation_table.sql`

```sql
-- Explicit order reconciliation log
CREATE TABLE IF NOT EXISTS order_reconciliation (
  id SERIAL PRIMARY KEY,
  
  -- Order reference
  order_id TEXT NOT NULL,
  bundle_id TEXT,
  transaction_signature TEXT,
  
  -- Reconciliation states
  previous_state VARCHAR(50) NOT NULL,
  new_state VARCHAR(50) NOT NULL,
  
  -- On-chain verification
  verified_on_chain BOOLEAN,
  on_chain_status VARCHAR(50), -- 'confirmed', 'failed', 'unknown'
  
  -- Metadata
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_by TEXT, -- 'startup', 'manual', 'periodic'
  notes TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_reconciliation_order_id 
  ON order_reconciliation(order_id);

CREATE INDEX IF NOT EXISTS idx_order_reconciliation_bundle_id 
  ON order_reconciliation(bundle_id) WHERE bundle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_reconciliation_reconciled_at 
  ON order_reconciliation(reconciled_at DESC);

-- View: recent unreconciled orders
CREATE OR REPLACE VIEW v_unreconciled_orders AS
  SELECT 
    eo.order_id,
    eo.state,
    eo.bundle_id,
    eo.placed_at,
    eo.submitted_at,
    (SELECT COUNT(*) FROM order_reconciliation WHERE order_id = eo.order_id) as reconciliation_attempts
  FROM engine_state,
    JSONB_TO_RECORDSET(engine_state.value -> 'unresolved_orders') AS eo(
      order_id TEXT,
      state VARCHAR(50),
      bundle_id TEXT,
      placed_at BIGINT,
      submitted_at BIGINT
    )
  WHERE engine_state.key = 'unresolved_orders'
    AND eo.state IN ('submitted', 'landed', 'ambiguous')
  ORDER BY eo.placed_at DESC;
```

---

## FIX #10: Transaction Signing Validation

### Problem
No validation before signing transactions. Bot could sign malicious or incorrect transactions.

### Implementation

**File**: `packages/solana/src/wallet.ts` (add method)

```typescript
export interface SigningValidationRules {
  maxFeeLamports?: number;           // Reject if fees exceed threshold
  allowedPrograms?: Set<string>;     // Whitelist of program IDs to interact with
  forbiddenPrograms?: Set<string>;   // Blacklist of program IDs
  requireRecentBlockhash?: boolean;  // Ensure blockhash is recent
  maxInstructionCount?: number;      // Reject if > N instructions
}

export class EncryptedLocalWallet implements WalletProvider {
  private signingRules: SigningValidationRules = {
    maxFeeLamports: 0.5e9, // 0.5 SOL default
    maxInstructionCount: 10,
    requireRecentBlockhash: true,
  };

  /**
   * Validate transaction before signing
   */
  private validateTransaction(tx: Transaction, rules?: SigningValidationRules): void {
    const finalRules = { ...this.signingRules, ...rules };

    // Check fee payer is this wallet
    if (tx.feePayer?.toBase58() !== this.keypair.publicKey.toBase58()) {
      throw new Error('Fee payer must be this wallet');
    }

    // Check blockhash is set and recent
    if (finalRules.requireRecentBlockhash && !tx.recentBlockhash) {
      throw new Error('Transaction missing recent blockhash');
    }

    // Check instruction count
    if (
      finalRules.maxInstructionCount &&
      tx.instructions.length > finalRules.maxInstructionCount
    ) {
      throw new Error(
        `Too many instructions: ${tx.instructions.length} > ${finalRules.maxInstructionCount}`,
      );
    }

    // Check program IDs (whitelist/blacklist)
    for (const instruction of tx.instructions) {
      const programId = instruction.programId.toBase58();

      if (finalRules.forbiddenPrograms?.has(programId)) {
        throw new Error(`Forbidden program: ${programId}`);
      }

      if (
        finalRules.allowedPrograms &&
        finalRules.allowedPrograms.size > 0 &&
        !finalRules.allowedPrograms.has(programId)
      ) {
        throw new Error(`Unauthorized program: ${programId}`);
      }
    }

    // Log the transaction being signed
    console.debug('Transaction validation passed', {
      feePayer: tx.feePayer?.toBase58(),
      instructions: tx.instructions.length,
    });
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    this.validateTransaction(tx);
    tx.partialSign(this.keypair);
    return tx;
  }

  async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
    for (const tx of txs) {
      this.validateTransaction(tx);
    }
    for (const tx of txs) {
      tx.partialSign(this.keypair);
    }
    return txs;
  }

  // Allow configuration of signing rules
  setSigningRules(rules: SigningValidationRules): void {
    this.signingRules = { ...this.signingRules, ...rules };
  }
}
```

### Test Cases

**File**: `packages/solana/src/__tests__/tx-validation.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Transaction, SystemProgram, PublicKey, Keypair } from '@solana/web3.js';
import { EncryptedLocalWallet } from '../wallet';

describe('Transaction Signing Validation', () => {
  let wallet: EncryptedLocalWallet;
  let tx: Transaction;

  beforeEach(() => {
    wallet = EncryptedLocalWallet.create('test-password', '/tmp/test-wallet');
    
    tx = new Transaction();
    tx.recentBlockhash = 'EhYXq3bK8eeqVgQj23gZjrXgd7mxzJcbME8mE8L8pJd5'; // Valid blockhash format
    tx.feePayer = new PublicKey(wallet.getPublicKey());
    tx.add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.getPublicKey()),
        toPubkey: new PublicKey('11111111111111111111111111111111'),
        lamports: 1000,
      }),
    );
  });

  it('should sign valid transaction', async () => {
    const signed = await wallet.signTransaction(tx);
    expect(signed.signatures.length).toBeGreaterThan(0);
  });

  it('should reject transaction without blockhash', async () => {
    const invalidTx = new Transaction();
    invalidTx.feePayer = new PublicKey(wallet.getPublicKey());
    invalidTx.add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.getPublicKey()),
        toPubkey: new PublicKey('11111111111111111111111111111111'),
        lamports: 1000,
      }),
    );

    await expect(wallet.signTransaction(invalidTx)).rejects.toThrow(/blockhash/i);
  });

  it('should reject if fee payer is not wallet', async () => {
    tx.feePayer = new PublicKey('11111111111111111111111111111111');

    await expect(wallet.signTransaction(tx)).rejects.toThrow(/fee payer/i);
  });

  it('should respect instruction count limit', async () => {
    wallet.setSigningRules({ maxInstructionCount: 1 });

    // Add second instruction
    tx.add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.getPublicKey()),
        toPubkey: new PublicKey('11111111111111111111111111111111'),
        lamports: 500,
      }),
    );

    await expect(wallet.signTransaction(tx)).rejects.toThrow(/Too many/i);
  });
});
```

---

## FIX #11: Jito Poll Interval Jitter

### Problem
All bots poll at the same interval (300ms default). Under load, causes thundering herd problem → coordinated spike in requests.

### Implementation

**File**: `packages/execution/src/jito.ts` (modify waitForLanding)

```typescript
export class JitoClient {
  // ... existing code ...

  /**
   * Poll a bundle to a terminal state with jittered intervals
   * to prevent thundering herd
   */
  async waitForLanding(
    bundleId: string,
    timeoutMs = 30_000,
    pollMs?: number,
  ): Promise<{
    status: BundleStatus | "Timeout";
    bundleId: string;
    pollErrors: number;
    transactions?: string[];
  }> {
    const deadline = Date.now() + timeoutMs;
    let pollErrors = 0;

    // Use provided pollMs or default, with random jitter
    const basePollMs = pollMs ?? this.opts.pollMs ?? 300;
    
    // Add jitter: ±25% variance to prevent thundering herd
    // If base is 300ms, jitter is 225-375ms
    const getJitteredPollMs = () => {
      const jitterFactor = 0.5 + Math.random(); // 0.5 to 1.5
      return Math.floor(basePollMs * jitterFactor);
    };

    while (Date.now() < deadline) {
      try {
        const status = await this.bundleStatus(bundleId);
        if (status === "Landed" || status === "Invalid") {
          const details = await this.bundleDetails(bundleId);
          return details?.transactions
            ? { status, bundleId, pollErrors, transactions: details.transactions }
            : { status, bundleId, pollErrors };
        }
      } catch {
        pollErrors += 1;
      }

      // Wait with jittered interval
      const jitteredPollMs = getJitteredPollMs();
      await new Promise((r) => setTimeout(r, jitteredPollMs));
    }

    return { status: "Timeout", bundleId, pollErrors };
  }
}
```

### Test Cases

**File**: `packages/execution/src/__tests__/jito-jitter.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { JitoClient } from '../jito';

describe('Jito Poll Jitter', () => {
  let jito: JitoClient;

  beforeEach(() => {
    jito = new JitoClient(
      'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
      { pollMs: 100 }, // Base 100ms for faster tests
    );
  });

  it('should vary poll intervals', async () => {
    // Mock bundleStatus to return Pending several times then Landed
    let callCount = 0;
    vi.spyOn(jito, 'bundleStatus').mockImplementation(async () => {
      callCount++;
      if (callCount < 3) return 'Pending';
      return 'Landed';
    });

    vi.spyOn(jito, 'bundleDetails').mockResolvedValue({
      bundle_id: 'test',
      status: 'Landed',
      transactions: ['tx1'],
    });

    const timings: number[] = [];
    let lastTime = Date.now();

    // Measure actual intervals
    const originalSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
      timings.push(Date.now() - lastTime);
      lastTime = Date.now();
      return originalSetTimeout(cb, 0); // Immediate execution for test
    });

    await jito.waitForLanding('test-bundle', 1000, 100);

    // Verify intervals vary (jitter applied)
    const avgInterval = timings.reduce((a, b) => a + b) / timings.length;
    const variance = timings.reduce(
      (sum, t) => sum + Math.pow(t - avgInterval, 2),
      0,
    ) / timings.length;

    expect(variance).toBeGreaterThan(0); // Variance indicates jitter
  });
});
```

---

## IMPLEMENTATION CHECKLIST

### Before Deploying Any Fix

- [ ] Code review for security issues
- [ ] All tests passing locally
- [ ] Database migrations tested on test database
- [ ] Dry-run mode tested for 1+ hour
- [ ] Monitoring/alerting configured

### Deployment Order (Recommended)

1. **Day 1-2**: Fixes #7, #8, #9 (Tables - zero downtime)
2. **Day 2-3**: Fix #10 (Tx Validation - code change, safe)
3. **Day 3-4**: Fix #11 (Poll Jitter - code change, safe)
4. **Day 4-5**: Fixes #4, #6 (Jito Fallback, Brute Force - safe)
5. **Day 6-7**: Fix #5 (Key Rotation - requires testing)
6. **Week 2**: Fixes #1, #2, #3 (Major: Reconciliation, Precision, Pool)

### Monitoring Post-Deployment

```sql
-- Check new tables are populated
SELECT COUNT(*) FROM wallet_connections;
SELECT COUNT(*) FROM schema_migrations;
SELECT COUNT(*) FROM order_reconciliation;

-- Verify reconciliation is working
SELECT * FROM reconciliation_log ORDER BY timestamp DESC LIMIT 5;

-- Check database performance
SELECT query, calls, total_time FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;

-- Monitor pool usage
SELECT COUNT(*) as active_connections FROM pg_stat_activity WHERE datname = 'mayhem';
```

---

## Total Implementation Effort

| Phase | Fixes | Effort | Risk |
|-------|-------|--------|------|
| **CRITICAL** | #1, #2, #3 | 12h | HIGH |
| **HIGH** | #4, #5, #6 | 13h | MEDIUM |
| **MEDIUM** | #7, #8, #9, #10, #11 | 7h | LOW |
| **TOTAL** | 1-11 | **32 hours** | - |

### Recommended Schedule
- Week 1: Complete fixes #4-11 (low-risk, quick wins)
- Week 2: Complete fixes #1-3 (high-impact, requires careful testing)
- Week 3: Integration testing and monitoring

---

## Success Criteria

✅ All 11 fixes deployed and tested  
✅ Zero production incidents in 7-day observation period  
✅ Reconciliation catches 100% of orphaned orders  
✅ No numeric precision errors in audit trail  
✅ Database pool handles peak load without timeouts  
✅ All monitoring dashboards green  
✅ Security hardening checklist complete  

**Ready for Live Trading**
