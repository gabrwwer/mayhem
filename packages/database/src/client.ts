
import { Pool, PoolClient, QueryResult, PoolConfig } from "pg";

type DatabaseLogger = {
  info?: (msg: string, data?: Record<string, unknown>) => void;
  warn?: (msg: string, data?: Record<string, unknown>) => void;
  error?: (msg: string, data?: Record<string, unknown>) => void;
  debug?: (msg: string, data?: Record<string, unknown>) => void;
};

export interface DatabasePoolConfig {
  /** Maximum number of connections in pool (default: 20) */
  maxConnections?: number;
  /** Idle connection timeout in ms (default: 30000) */
  idleTimeoutMs?: number;
  /** Statement timeout in ms per query (default: 5000) */
  statementTimeoutMs?: number;
  /** Connection timeout in ms (default: 10000) */
  connectionTimeoutMs?: number;
}

export class DatabaseClient {
  private pool: Pool;
  private statementTimeoutMs: number;
  private logger: DatabaseLogger | undefined;

  constructor(
    connectionString?: string,
    config?: DatabasePoolConfig,
    logger?: DatabaseLogger,
  ) {
    this.logger = logger;

    const poolConfig: PoolConfig = {
      connectionString:
        connectionString ?? process.env["DATABASE_URL"],
      
      // Pool size
      max: config?.maxConnections ?? 
        parseInt(process.env["DATABASE_POOL_MAX"] ?? "20"),
      
      // Idle connection timeout (milliseconds)
      idleTimeoutMillis: config?.idleTimeoutMs ??
        parseInt(process.env["DATABASE_POOL_IDLE_TIMEOUT_MS"] ?? "30000"),
      
      // Connection acquisition timeout
      connectionTimeoutMillis: config?.connectionTimeoutMs ??
        parseInt(process.env["DATABASE_CONNECTION_TIMEOUT_MS"] ?? "10000"),
    };

    this.pool = new Pool(poolConfig);
    this.statementTimeoutMs = config?.statementTimeoutMs ??
      parseInt(process.env["DATABASE_QUERY_TIMEOUT_MS"] ?? "5000");

    // Pool error handler
    this.pool.on('error', (err) => {
      this.logger?.error?.('Unexpected pool error', {
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof Error && 'code' in err ? (err as any).code : 'UNKNOWN',
      });
    });

    // Log pool events (helpful for debugging)
    if (process.env["DEBUG_DATABASE_POOL"] === "true") {
      this.pool.on('connect', () => {
        this.logger?.debug?.('Pool: connection acquired', {
          availableCount: this.pool.idleCount,
          totalCount: this.pool.totalCount,
        });
      });
    }
  }

  async query<T extends object = object>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      // Set per-connection statement timeout
      await client.query(`SET statement_timeout = ${this.statementTimeoutMs}`);
      return await client.query<T>(sql, params);
    } finally {
      client.release();
    }
  }

  async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT 1 as connected');
      if (result.rows[0]?.connected !== 1) {
        throw new Error('Database health check failed');
      }
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    // Wait for existing queries to complete (up to 10s)
    const deadline = Date.now() + 10_000;
    while (this.pool.waitingCount > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    
    if (this.pool.waitingCount > 0) {
      this.logger?.warn?.('Forcefully terminating waiting queries');
    }

    await this.pool.end();
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${this.statementTimeoutMs}`);
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A failing ROLLBACK (usually a dead connection) must not replace the
      // error that actually caused the failure — that swaps a meaningful
      // diagnostic for a misleading one. Log it and rethrow the original.
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        this.logger?.error?.("[DatabaseClient] ROLLBACK failed:", {
          error: rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Execute related operations on one physical connection.
   *
   * Session-scoped Postgres facilities, including advisory locks, must not be
   * used through `query()`: each call may be served by a different pooled
   * connection.  This method deliberately does not create a transaction; the
   * caller controls transaction boundaries while retaining connection affinity.
   */
  async withConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${this.statementTimeoutMs}`);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * Get pool statistics (for monitoring)
   */
  getPoolStats(): {
    totalConnections: number;
    availableConnections: number;
    waitingRequests: number;
    idleConnections: number;
  } {
    return {
      totalConnections: this.pool.totalCount,
      availableConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      idleConnections: this.pool.idleCount,
    };
  }
}
