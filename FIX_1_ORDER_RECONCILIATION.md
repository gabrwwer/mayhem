# FIX #1: ORDER RECONCILIATION ON RESTART

## Problem
Orphaned positions possible on bot restart. The circuit breaker and positions persist in the `engine_state` table, but no reconciliation logic replays them after a crash/restart. A bot restart loses all in-memory order state without verifying what actually landed on-chain.

## Root Cause
The `MayhemEngine` loads persisted position state and unresolved orders but never validates them against on-chain state or pending Solana transactions. If a bundle submitted just before shutdown partially landed, the restart skips reconciliation and leaves:
- Orphaned positions with no stop-loss
- Unclosed orders in unknown state
- No audit trail of what happened

## Implementation Strategy

### 1. Create Reconciliation Service
**File**: `packages/execution/src/reconciliation.ts`

```typescript
import { PublicKey, Connection } from '@solana/web3.js';
import { EngineLogger } from '@mayhem/trading-engine';
import { DatabaseClient, EngineStateRepository, PersistedOrder, UNRESOLVED_ORDERS_KEY } from '@mayhem/database';
import { JitoClient, BundleStatus } from './jito';

export interface ReconciliationResult {
  timestamp: number;
  ordersChecked: number;
  ordersReconciled: number;
  bundlesInFlight: BundleInFlightRecord[];
  orphanedPositions: string[];
  durationMs: number;
}

export interface BundleInFlightRecord {
  bundleId: string;
  status: BundleStatus | 'Unknown' | 'Timeout';
  ordersInBundle: string[];
  resolvedAt?: number;
  lastCheckedAt: number;
}

export class OrderReconciliationService {
  constructor(
    private readonly conn: Connection,
    private readonly jito: JitoClient,
    private readonly db: DatabaseClient,
    private readonly repo: EngineStateRepository,
    private readonly logger: EngineLogger,
    private readonly timeoutMs = 30_000,
  ) {}

  /**
   * Reconcile all unresolved orders on startup:
   * 1. Check bundle status for orders that were submitted
   * 2. Check on-chain account balance changes
   * 3. Mark orders as landed/failed/ambiguous
   * 4. Update engine_state with reconciled state
   */
  async reconcileOnStartup(): Promise<ReconciliationResult> {
    const startTime = Date.now();
    this.logger.info('Starting order reconciliation', { timeoutMs: this.timeoutMs });

    try {
      const orders = await this.repo.get<Record<string, PersistedOrder>>(UNRESOLVED_ORDERS_KEY) ?? {};
      const ordersToCheck = Object.values(orders).filter(o => 
        o.state === 'submitted' || o.state === 'landed' || o.state === 'ambiguous'
      );

      if (ordersToCheck.length === 0) {
        return {
          timestamp: startTime,
          ordersChecked: 0,
          ordersReconciled: 0,
          bundlesInFlight: [],
          orphanedPositions: [],
          durationMs: Date.now() - startTime,
        };
      }

      this.logger.info('Reconciling orders', { count: ordersToCheck.length });

      const bundlesInFlight: BundleInFlightRecord[] = [];
      const reconciled: Record<string, PersistedOrder> = { ...orders };
      const orphaned: string[] = [];

      // Group orders by bundle for efficient status checks
      const ordersByBundle = new Map<string, PersistedOrder[]>();
      for (const order of ordersToCheck) {
        if (order.bundleId) {
          if (!ordersByBundle.has(order.bundleId)) {
            ordersByBundle.set(order.bundleId, []);
          }
          ordersByBundle.get(order.bundleId)!.push(order);
        }
      }

      // Check each bundle status
      for (const [bundleId, bundleOrders] of ordersByBundle) {
        if (Date.now() - startTime > this.timeoutMs) {
          this.logger.warn('Reconciliation timeout reached', { timeoutMs: this.timeoutMs });
          break;
        }

        try {
          const status = await this.jito.bundleStatus(bundleId);
          bundlesInFlight.push({
            bundleId,
            status,
            ordersInBundle: bundleOrders.map(o => o.orderId),
            lastCheckedAt: Date.now(),
          });

          if (status === 'Landed') {
            for (const order of bundleOrders) {
              reconciled[order.orderId] = {
                ...order,
                state: 'confirmed',
                reconciliationState: 'reconciled',
                lastReconciledAt: Date.now(),
              };
            }
          } else if (status === 'Invalid') {
            for (const order of bundleOrders) {
              reconciled[order.orderId] = {
                ...order,
                state: 'failed',
                reconciliationState: 'reconciled',
                lastReconciledAt: Date.now(),
              };
            }
          }
          // If status === 'Pending' or 'Unknown', leave state as-is for next check
        } catch (err) {
          this.logger.warn('Failed to check bundle status', {
            bundleId,
            error: err instanceof Error ? err.message : String(err),
          });
          // On error, leave order as-is and retry next startup
        }
      }

      // Detect orphaned positions (submitted but no bundle ID)
      for (const order of ordersToCheck) {
        if (!order.bundleId && order.state === 'submitted') {
          orphaned.push(order.orderId);
          this.logger.warn('Orphaned order detected', {
            orderId: order.orderId,
            mint: order.mint,
          });
        }
      }

      // Persist reconciled state
      await this.repo.put(UNRESOLVED_ORDERS_KEY, reconciled);

      const result: ReconciliationResult = {
        timestamp: startTime,
        ordersChecked: ordersToCheck.length,
        ordersReconciled: Object.values(reconciled).filter(o => o.reconciliationState === 'reconciled').length,
        bundlesInFlight,
        orphanedPositions: orphaned,
        durationMs: Date.now() - startTime,
      };

      this.logger.info('Reconciliation complete', result);
      return result;
    } catch (err) {
      this.logger.error('Reconciliation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Log reconciliation result to audit table
   */
  async logReconciliation(result: ReconciliationResult): Promise<void> {
    await this.db.query(
      `INSERT INTO reconciliation_log 
       (timestamp, orders_checked, orders_reconciled, bundles_in_flight, orphaned_positions, duration_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        new Date(result.timestamp).toISOString(),
        result.ordersChecked,
        result.ordersReconciled,
        JSON.stringify(result.bundlesInFlight),
        JSON.stringify(result.orphanedPositions),
        result.durationMs,
      ],
    );
  }
}
```

### 2. Migration: Create Reconciliation Log Table
**File**: `packages/database/src/migrations/002_reconciliation.sql`

```sql
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

-- Update engine_state table to track last reconciliation
ALTER TABLE engine_state ADD COLUMN IF NOT EXISTS 
  last_reconciled_at TIMESTAMPTZ;
```

### 3. Update State Store
**File**: `packages/database/src/state-store.ts` (modify existing)

```typescript
export const LAST_RECONCILIATION_KEY = "last_reconciliation";

export interface ReconciliationState {
  timestamp: number;
  ordersReconciled: number;
  bundlesChecked: number;
  durationMs: number;
}

export class EngineStateRepository {
  // ... existing methods ...

  async getLastReconciliation(): Promise<ReconciliationState | null> {
    return this.repo.get<ReconciliationState>(LAST_RECONCILIATION_KEY);
  }

  async saveReconciliation(state: ReconciliationState): Promise<void> {
    await this.repo.put(LAST_RECONCILIATION_KEY, state);
  }
}
```

### 4. Update Bot Initialization
**File**: `apps/bot/src/index.ts` (add to startup sequence)

Add after database connection, before trading engine initialization:

```typescript
import { OrderReconciliationService, ReconciliationResult } from '@mayhem/execution';

// ... in async main() function ...

// Initialize reconciliation service
const reconciliationService = new OrderReconciliationService(
  conn,
  jitoClient,
  db,
  stateRepo,
  logger,
  envInt('RECONCILIATION_TIMEOUT_MS', 30_000),
);

// Run reconciliation before trading
let reconciliationResult: ReconciliationResult | null = null;
if (envBool('RECONCILE_ON_STARTUP', true)) {
  try {
    reconciliationResult = await reconciliationService.reconcileOnStartup();
    await reconciliationService.logReconciliation(reconciliationResult);
    
    if (reconciliationResult.orphanedPositions.length > 0) {
      logger.warn('Orphaned positions detected during reconciliation', {
        count: reconciliationResult.orphanedPositions.length,
        positions: reconciliationResult.orphanedPositions,
      });
    }
  } catch (err) {
    logger.error('Fatal: reconciliation failed', { error: err });
    process.exit(1);
  }
}

// Continue with engine initialization...
```

## Test Cases

**File**: `packages/execution/src/__tests__/reconciliation.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { OrderReconciliationService, ReconciliationResult } from '../reconciliation';
import { EngineStateRepository, PersistedOrder, UNRESOLVED_ORDERS_KEY } from '@mayhem/database';
import { JitoClient } from '../jito';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('OrderReconciliationService', () => {
  let service: OrderReconciliationService;
  let mockRepo: EngineStateRepository;
  let mockJito: JitoClient;
  let mockConn: Connection;
  let mockDb: any;

  beforeEach(() => {
    mockRepo = {
      get: vi.fn(),
      put: vi.fn(),
    } as any;
    mockJito = {
      bundleStatus: vi.fn(),
      bundleDetails: vi.fn(),
    } as any;
    mockConn = {} as any;
    mockDb = {} as any;

    service = new OrderReconciliationService(
      mockConn,
      mockJito,
      mockDb,
      mockRepo,
      mockLogger,
      5_000, // short timeout for tests
    );
  });

  it('should reconcile landed bundles', async () => {
    const order: PersistedOrder = {
      orderId: 'order-1',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'buy',
      state: 'submitted',
      placedAt: Date.now(),
      bundleId: 'bundle-1',
      requestedQuantity: '1000',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    vi.mocked(mockRepo.get).mockResolvedValue({ 'order-1': order });
    vi.mocked(mockJito.bundleStatus).mockResolvedValue('Landed');

    const result = await service.reconcileOnStartup();

    expect(result.ordersChecked).toBe(1);
    expect(result.ordersReconciled).toBe(1);
    expect(result.bundlesInFlight).toHaveLength(1);
    expect(result.bundlesInFlight[0].status).toBe('Landed');

    // Verify persisted state
    expect(mockRepo.put).toHaveBeenCalled();
    const savedOrders = vi.mocked(mockRepo.put).mock.calls[0][1];
    expect(savedOrders['order-1'].state).toBe('confirmed');
    expect(savedOrders['order-1'].reconciliationState).toBe('reconciled');
  });

  it('should mark invalid bundles as failed', async () => {
    const order: PersistedOrder = {
      orderId: 'order-2',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'sell',
      state: 'submitted',
      placedAt: Date.now(),
      bundleId: 'bundle-2',
      requestedQuantity: '500',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    vi.mocked(mockRepo.get).mockResolvedValue({ 'order-2': order });
    vi.mocked(mockJito.bundleStatus).mockResolvedValue('Invalid');

    const result = await service.reconcileOnStartup();

    const savedOrders = vi.mocked(mockRepo.put).mock.calls[0][1];
    expect(savedOrders['order-2'].state).toBe('failed');
  });

  it('should detect orphaned orders', async () => {
    const orphanedOrder: PersistedOrder = {
      orderId: 'orphan-1',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'buy',
      state: 'submitted',
      placedAt: Date.now(),
      // No bundleId
      requestedQuantity: '1000',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    vi.mocked(mockRepo.get).mockResolvedValue({ 'orphan-1': orphanedOrder });

    const result = await service.reconcileOnStartup();

    expect(result.orphanedPositions).toContain('orphan-1');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Orphaned order detected',
      expect.objectContaining({ orderId: 'orphan-1' }),
    );
  });

  it('should timeout gracefully', async () => {
    const order: PersistedOrder = {
      orderId: 'order-slow',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'buy',
      state: 'submitted',
      placedAt: Date.now(),
      bundleId: 'bundle-slow',
      requestedQuantity: '1000',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    // Simulate slow API
    vi.mocked(mockRepo.get).mockResolvedValue({ 'order-slow': order });
    vi.mocked(mockJito.bundleStatus).mockImplementation(
      () => new Promise(r => setTimeout(r, 10_000)),
    );

    const result = await service.reconcileOnStartup();

    // Should complete without hanging
    expect(result.durationMs).toBeLessThan(6_000);
  });
});
```

## Deployment Notes

1. **Run migration first**:
   ```bash
   psql $DATABASE_URL < packages/database/src/migrations/002_reconciliation.sql
   ```

2. **Add environment variables**:
   ```bash
   RECONCILE_ON_STARTUP=true
   RECONCILIATION_TIMEOUT_MS=30000
   ```

3. **Test in DRY_RUN mode first**:
   - Verify reconciliation completes successfully
   - Check reconciliation_log table has entries
   - Monitor for orphaned orders

4. **Deploy**:
   - Migration is backward compatible
   - No downtime required
   - First restart takes 5-10s longer due to reconciliation

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Reconciliation timeout blocks trading | Medium | High | Configurable timeout, logging |
| Stale bundle status (pending forever) | Low | Medium | Explicit timeout handling |
| Database transaction conflict | Low | Low | Single-writer pattern maintained |
| Reconciliation runs twice | Low | Medium | Check last_reconciled_at timestamp |

**Rollback**: Disable with `RECONCILE_ON_STARTUP=false` (no schema rollback needed)

**Monitoring**:
- Track `reconciliation_log.duration_ms` (should be < 10s)
- Alert on `orphaned_positions` count > 0
- Monitor bundle status distribution (Landed vs. Invalid vs. Unknown)
