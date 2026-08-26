import { DatabaseClient } from "./client";

/**
 * Durable key/value store for engine state that MUST survive a restart.
 *
 * Two things live here today:
 *   - circuit-breaker state (kill switch, daily loss, loss streak, peak
 *     equity). Held only in memory, a restart resets every capital limit.
 *   - open positions. Held only in memory, a restart orphans real holdings
 *     with no stop-loss and no record that they exist.
 *
 * A single row-per-key table is deliberate: these are small, whole-object,
 * read-once-at-boot documents. Modelling them as columns would mean a
 * migration every time a risk field is added, and a partially-migrated
 * schema is a far worse failure mode than a JSONB blob.
 */

export const ENGINE_STATE_TABLE = "engine_state";

/** Applied by scripts/maintenance/migrate.ts. Idempotent. */
export const ENGINE_STATE_DDL = `
CREATE TABLE IF NOT EXISTS ${ENGINE_STATE_TABLE} (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const BREAKER_STATE_KEY = "circuit_breaker";
export const OPEN_POSITIONS_KEY = "open_positions";
export const UNRESOLVED_ORDERS_KEY = "unresolved_orders";
export const LAST_RECONCILIATION_KEY = "last_reconciliation";

export interface ReconciliationState {
  timestamp: number;
  ordersReconciled: number;
  bundlesChecked: number;
  durationMs: number;
}

export type PersistedOrderState =
  | "prepared"
  | "submitted"
  | "landed"
  | "confirmed"
  | "partially_filled"
  | "failed"
  | "ambiguous"
  | "reconciled";

export interface PersistedOrder {
  orderId: string;
  mint: string;
  side: "buy" | "sell";
  state: PersistedOrderState;
  placedAt: number;
  bundleId?: string;
  transactionSignature?: string;
  requestedQuantity: string;
  filledQuantity?: string;
  requestedPositionSol?: string;
  actualSolSpent?: string;
  actualSolReceived?: string;
  feesLamports?: string;
  feesSol?: string;
  submittedAt?: number;
  landedAt?: number;
  confirmedAt?: number;
  lastReconciledAt?: number;
  retryCount: number;
  reconciliationState: "unreconciled" | "reconciling" | "reconciled" | "failed";
  errorCode?: string;
}

export class EngineStateRepository {
  constructor(private readonly db: DatabaseClient) {}

  async ensureSchema(): Promise<void> {
    await this.db.query(ENGINE_STATE_DDL);
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.db.query<{ value: T }>(
      `SELECT value FROM ${ENGINE_STATE_TABLE} WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  /**
   * Upsert. Concurrency note: the bot is the single writer for each key, so
   * last-write-wins is correct here. If a second writer is ever introduced
   * this needs optimistic locking on `updated_at`, not a bigger transaction.
   */
  async put<T>(key: string, value: T): Promise<void> {
    await this.db.query(
      `INSERT INTO ${ENGINE_STATE_TABLE} (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ${ENGINE_STATE_TABLE} WHERE key = $1`,
      [key],
    );
  }

  async getLastReconciliation(): Promise<ReconciliationState | null> {
    return this.get<ReconciliationState>(LAST_RECONCILIATION_KEY);
  }

  async saveReconciliation(state: ReconciliationState): Promise<void> {
    await this.put(LAST_RECONCILIATION_KEY, state);
  }
}

/**
 * Postgres implementation of the risk-engine's BreakerStateStore port.
 *
 * Structurally typed against `@mayhem/risk-engine`'s interface rather than
 * importing it, so the database package does not take a dependency on the
 * risk package (the dependency runs the other way round at wiring time).
 */
/**
 * The type parameter is on the CLASS, not the methods. With method-level
 * generics (`load<T>()`) the class is not assignable to a port that
 * declares a concrete return type, so callers were forced into `as` casts
 * that would silently accept a mismatched shape.
 */
export class PostgresBreakerStateStore<T = unknown> {
  constructor(private readonly repo: EngineStateRepository) {}

  async load(): Promise<T | null> {
    return this.repo.get<T>(BREAKER_STATE_KEY);
  }

  async save(state: T): Promise<void> {
    await this.repo.put(BREAKER_STATE_KEY, state);
  }
}

/** Postgres implementation of the trading-engine's PositionStore port. */
export class PostgresPositionStore<T = unknown> {
  constructor(private readonly repo: EngineStateRepository) {}

  async loadOpen(): Promise<T[]> {
    return (await this.repo.get<T[]>(OPEN_POSITIONS_KEY)) ?? [];
  }

  async saveOpen(positions: T[]): Promise<void> {
    await this.repo.put(OPEN_POSITIONS_KEY, positions);
  }
}

/**
 * Postgres-backed unresolved-order store. It uses the same engine_state
 * document store as breaker and position state; there is no competing
 * persistence backend for execution state.
 */
export class PostgresOrderStore {
  constructor(private readonly repo: EngineStateRepository) {}

  async load(): Promise<Record<string, PersistedOrder>> {
    return (
      (await this.repo.get<Record<string, PersistedOrder>>(UNRESOLVED_ORDERS_KEY)) ?? {}
    );
  }

  async save(orders: Record<string, PersistedOrder>): Promise<void> {
    await this.repo.put(UNRESOLVED_ORDERS_KEY, orders);
  }
}
