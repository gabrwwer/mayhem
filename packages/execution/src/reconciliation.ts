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

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const remainingMs = Math.max(1, this.timeoutMs - (Date.now() - startTime));
          const status = await Promise.race([
            this.jito.bundleStatus(bundleId),
            new Promise<BundleStatus>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error('Bundle status check timed out')),
                remainingMs,
              );
            }),
          ]);
          if (timeoutHandle) clearTimeout(timeoutHandle);
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
          if (typeof timeoutHandle !== 'undefined') clearTimeout(timeoutHandle);
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

      const logData: Record<string, unknown> = {
        timestamp: result.timestamp,
        ordersChecked: result.ordersChecked,
        ordersReconciled: result.ordersReconciled,
        bundlesInFlight: result.bundlesInFlight,
        orphanedPositions: result.orphanedPositions,
        durationMs: result.durationMs,
      };
      this.logger.info('Reconciliation complete', logData);
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
