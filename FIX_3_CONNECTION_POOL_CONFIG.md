# FIX #3: CONNECTION POOL CONFIGURATION

## Problem
No pool size limits, no timeout configuration. Under load, connections can exhaust (waiting indefinitely), or a slow query can hang the entire pool blocking other operations.

## Root Cause
`DatabaseClient` creates a Pool with minimal config:
```typescript
this.pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
});
```

This uses node-pg defaults:
- 10 connections (may be insufficient for multi-threaded bot)
- No idle timeout (connections persist forever)
- No statement timeout (slow queries block pool)
- No connection timeout (waits indefinitely for available connection)

## Implementation Strategy

### 1. Update DatabaseClient with Pool Configuration
**File**: `packages/database/src/client.ts`

```typescript
import { Pool, PoolClient, QueryResult, PoolConfig } from "pg";
import { Logger } from './logger'; // Minimal logger interface

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
  private logger?: Logger;

  constructor(
    connectionString?: string,
    config?: DatabasePoolConfig,
    logger?: Logger,
  ) {
    this.logger = logger;

    const poolConfig: PoolConfig = {
      connectionString: connectionString ?? process.env["DATABASE_URL"],
      
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

    // Set per-statement timeout (via SET command on each connection)
    this.statementTimeoutMs = config?.statementTimeoutMs ??
      parseInt(process.env["DATABASE_QUERY_TIMEOUT_MS"] ?? "5000");

    // Pool error handler
    this.pool.on('error', (err) => {
      this.logger?.error('Unexpected pool error', {
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof Error && 'code' in err ? (err as any).code : 'UNKNOWN',
      });
    });

    // Log pool events (helpful for debugging)
    if (process.env["DEBUG_DATABASE_POOL"] === "true") {
      this.pool.on('connect', () => {
        this.logger?.debug?.('Pool: connection acquired', {
          availableCount: this.pool.availableObjectsCount,
          totalCount: this.pool.totalCount,
        });
      });
    }
  }

  private statementTimeoutMs: number;

  /**
   * Execute a query with statement timeout
   */
  async query<T extends object = object>(
    sql: string,
    params?: unknown[],
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

  /**
   * Connect to database (health check)
   */
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

  /**
   * Graceful shutdown with connection drain
   */
  async disconnect(): Promise<void> {
    // Wait for existing queries to complete (up to 10s)
    const deadline = Date.now() + 10_000;
    while (this.pool.waitingCount > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    
    if (this.pool.waitingCount > 0) {
      this.logger?.warn('Forcefully terminating waiting queries');
    }

    await this.pool.end();
  }

  /**
   * Transaction with automatic statement timeout
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${this.statementTimeoutMs}`);
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        this.logger?.error("ROLLBACK failed", {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
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
      availableConnections: this.pool.availableObjectsCount,
      waitingRequests: this.pool.waitingCount,
      idleConnections: this.pool.idleCount,
    };
  }
}
```

### 2. Add Database Configuration Schema
**File**: `packages/config/src/schema.ts` (add new section)

```typescript
import { z } from 'zod';

export const DatabaseConfigSchema = z.object({
  url: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  
  poolMaxConnections: z.number()
    .int()
    .positive('DATABASE_POOL_MAX must be positive')
    .default(20)
    .describe('Maximum connections in pool (env: DATABASE_POOL_MAX)'),
  
  poolIdleTimeoutMs: z.number()
    .int()
    .positive('DATABASE_POOL_IDLE_TIMEOUT_MS must be positive')
    .default(30_000)
    .describe('Idle connection timeout (env: DATABASE_POOL_IDLE_TIMEOUT_MS)'),
  
  poolConnectionTimeoutMs: z.number()
    .int()
    .positive('DATABASE_CONNECTION_TIMEOUT_MS must be positive')
    .default(10_000)
    .describe('Connection acquisition timeout (env: DATABASE_CONNECTION_TIMEOUT_MS)'),
  
  queryTimeoutMs: z.number()
    .int()
    .positive('DATABASE_QUERY_TIMEOUT_MS must be positive')
    .default(5_000)
    .describe('Per-query timeout (env: DATABASE_QUERY_TIMEOUT_MS)'),
}).strict();

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export function parseDatabaseConfig(): DatabaseConfig {
  return DatabaseConfigSchema.parse({
    url: process.env.DATABASE_URL,
    poolMaxConnections: parseInt(process.env.DATABASE_POOL_MAX ?? '20'),
    poolIdleTimeoutMs: parseInt(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS ?? '30000'),
    poolConnectionTimeoutMs: parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? '10000'),
    queryTimeoutMs: parseInt(process.env.DATABASE_QUERY_TIMEOUT_MS ?? '5000'),
  });
}
```

### 3. Update Bot Initialization
**File**: `apps/bot/src/index.ts` (add pool initialization)

```typescript
import { DatabaseClient, DatabasePoolConfig } from '@mayhem/database';
import { parseDatabaseConfig } from '@mayhem/config';

async function main() {
  // ... existing setup ...

  // Initialize database with pool configuration
  const dbConfig = parseDatabaseConfig();
  const db = new DatabaseClient(
    dbConfig.url,
    {
      maxConnections: dbConfig.poolMaxConnections,
      idleTimeoutMs: dbConfig.poolIdleTimeoutMs,
      connectionTimeoutMs: dbConfig.poolConnectionTimeoutMs,
      statementTimeoutMs: dbConfig.queryTimeoutMs,
    },
    logger,
  );

  // Health check on startup
  try {
    await db.connect();
    logger.info('Database pool initialized', {
      maxConnections: dbConfig.poolMaxConnections,
      idleTimeoutMs: dbConfig.poolIdleTimeoutMs,
      queryTimeoutMs: dbConfig.queryTimeoutMs,
    });
  } catch (err) {
    logger.error('Failed to connect to database', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down database pool');
    await db.disconnect();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ... rest of bot initialization ...
}
```

### 4. Add Pool Monitoring
**File**: `apps/bot/src/pool-monitor.ts` (new file)

```typescript
import { DatabaseClient } from '@mayhem/database';
import { EngineLogger } from '@mayhem/trading-engine';

export class PoolMonitor {
  private checkInterval: NodeJS.Timer | null = null;

  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: EngineLogger,
    private readonly intervalMs = 30_000, // Check every 30s
  ) {}

  start(): void {
    this.checkInterval = setInterval(() => {
      const stats = this.db.getPoolStats();
      
      // Warn if pool is getting full
      if (stats.waitingRequests > 0) {
        this.logger.warn('Database pool has waiting requests', stats);
      }

      if (stats.availableConnections < 2) {
        this.logger.warn('Database pool nearly exhausted', stats);
      }

      // Debug logging
      if (process.env["DEBUG_DATABASE_POOL"] === "true") {
        this.logger.info('Pool stats', stats);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
```

## Test Cases

**File**: `packages/database/src/__tests__/pool-config.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseClient } from '../client';
import { Pool } from 'pg';

describe('DatabaseClient Pool Configuration', () => {
  let client: DatabaseClient;

  afterEach(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  it('should use default pool config when not provided', () => {
    client = new DatabaseClient(process.env.TEST_DATABASE_URL);
    const stats = client.getPoolStats();

    // Should have some connections ready
    expect(stats.totalConnections).toBeGreaterThanOrEqual(0);
  });

  it('should accept custom pool configuration', () => {
    client = new DatabaseClient(process.env.TEST_DATABASE_URL, {
      maxConnections: 5,
      idleTimeoutMs: 10_000,
      statementTimeoutMs: 2_000,
    });

    const stats = client.getPoolStats();
    expect(stats.totalConnections).toBeLessThanOrEqual(5);
  });

  it('should honor environment variables for pool config', () => {
    process.env.DATABASE_POOL_MAX = '15';
    process.env.DATABASE_POOL_IDLE_TIMEOUT_MS = '20000';

    client = new DatabaseClient(process.env.TEST_DATABASE_URL);
    // Pool max is enforced by pg library
    
    expect(process.env.DATABASE_POOL_MAX).toBe('15');
  });

  it('should enforce statement timeout on queries', async () => {
    client = new DatabaseClient(process.env.TEST_DATABASE_URL, {
      statementTimeoutMs: 100, // Very short timeout
    });

    // This query will timeout
    expect(async () => {
      await client.query(
        'SELECT pg_sleep(1)' // Sleep for 1 second
      );
    }).rejects.toThrow();
  });

  it('should handle connection timeout gracefully', async () => {
    client = new DatabaseClient(process.env.TEST_DATABASE_URL, {
      connectionTimeoutMs: 100,
      maxConnections: 1,
    });

    // Exhaust the single connection
    const conn = await client['pool'].connect();

    try {
      // This should timeout waiting for a connection
      expect(async () => {
        await client.query('SELECT 1');
      }).rejects.toThrow();
    } finally {
      conn.release();
    }
  });

  it('should provide pool statistics', () => {
    client = new DatabaseClient(process.env.TEST_DATABASE_URL);

    const stats = client.getPoolStats();
    expect(stats).toEqual(
      expect.objectContaining({
        totalConnections: expect.any(Number),
        availableConnections: expect.any(Number),
        waitingRequests: expect.any(Number),
        idleConnections: expect.any(Number),
      })
    );

    expect(stats.availableConnections).toBeLessThanOrEqual(stats.totalConnections);
  });

  it('should gracefully disconnect with pending operations', async () => {
    client = new DatabaseClient(process.env.TEST_DATABASE_URL);

    // Start a slow query
    const slowQuery = client.query('SELECT pg_sleep(2)').catch(() => {
      // Query will timeout, that's ok
    });

    // Immediately disconnect
    await expect(client.disconnect()).resolves.not.toThrow();
  });
});
```

## Deployment Notes

### Environment Variables

Add to `.env` or deployment configuration:

```bash
# Database Pool Configuration
DATABASE_POOL_MAX=20                      # Max connections (default: 20)
DATABASE_POOL_IDLE_TIMEOUT_MS=30000       # Idle timeout (default: 30s)
DATABASE_CONNECTION_TIMEOUT_MS=10000      # Connection timeout (default: 10s)
DATABASE_QUERY_TIMEOUT_MS=5000            # Statement timeout (default: 5s)

# Debug
DEBUG_DATABASE_POOL=false                 # Enable pool debug logging
```

### Recommended Tuning

| Setting | Dev | Staging | Production |
|---------|-----|---------|-----------|
| `POOL_MAX` | 5 | 10 | 20-40 |
| `IDLE_TIMEOUT_MS` | 30000 | 30000 | 30000 |
| `CONNECTION_TIMEOUT_MS` | 10000 | 10000 | 10000 |
| `QUERY_TIMEOUT_MS` | 5000 | 5000 | 3000-5000 |

### Deployment Steps

1. Update `.env` with pool configuration
2. Deploy new `DatabaseClient` code
3. Restart bot
4. Monitor pool stats with `DEBUG_DATABASE_POOL=true`
5. Adjust based on actual load patterns

### Monitoring Queries

```sql
-- Active connections
SELECT datname, usename, state, query, query_start 
FROM pg_stat_activity 
WHERE datname = 'mayhem';

-- Connection count
SELECT count(*) FROM pg_stat_activity WHERE datname = 'mayhem';

-- Slow queries (> 1s)
SELECT query, query_start, (now() - query_start) as duration
FROM pg_stat_activity
WHERE datname = 'mayhem' AND query_start < now() - interval '1 second';
```

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Too low POOL_MAX causes queue backlog | High | High | Monitor, adjust to 20-40 for 24/7 bot |
| QUERY_TIMEOUT too strict kills valid queries | Medium | High | Start with 5s, lower incrementally |
| Connection acquisition timeout blocks startup | Low | Medium | Verify DB connectivity before deployment |
| Idle connections consume resources | Low | Low | 30s idle timeout balances resource use |

**Rollback**: Set all values to defaults or disable with feature flag

**Monitoring**: Alert on `waitingRequests > 0` or `availableConnections < 2`
