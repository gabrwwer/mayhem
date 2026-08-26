import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseClient, DatabasePoolConfig } from '../client';

describe('DatabaseClient Pool Configuration', () => {
  let client: DatabaseClient | null = null;

  afterEach(async () => {
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        // Ignore disconnect errors in cleanup
      }
      client = null;
    }
  });

  it('should use default pool config when not provided', () => {
    // Skip if no test database URL
    if (!process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']) {
      console.log('Skipping test: no database URL configured');
      return;
    }

    client = new DatabaseClient(process.env['TEST_DATABASE_URL'] || process.env['DATABASE_URL']);
    const stats = client.getPoolStats();

    // Should have pool initialized
    expect(stats.totalConnections).toBeLessThanOrEqual(20);
  });

  it('should accept custom pool configuration', () => {
    if (!process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']) {
      console.log('Skipping test: no database URL configured');
      return;
    }

    const config: DatabasePoolConfig = {
      maxConnections: 5,
      idleTimeoutMs: 10_000,
      statementTimeoutMs: 2_000,
    };

    client = new DatabaseClient(process.env['TEST_DATABASE_URL'] || process.env['DATABASE_URL'], config);
    const stats = client.getPoolStats();

    // Pool should respect max connections
    expect(stats.totalConnections).toBeLessThanOrEqual(5);
  });

  it('should provide pool statistics', () => {
    if (!process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']) {
      console.log('Skipping test: no database URL configured');
      return;
    }

    client = new DatabaseClient(process.env['TEST_DATABASE_URL'] || process.env['DATABASE_URL']);

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

  it('should handle connection and disconnection gracefully', async () => {
    if (!process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']) {
      console.log('Skipping test: no database URL configured');
      return;
    }

    client = new DatabaseClient(process.env['TEST_DATABASE_URL'] || process.env['DATABASE_URL']);

    // Connect
    await expect(client.connect()).resolves.not.toThrow();

    // Should be able to query
    const result = await client.query<{ test: number }>('SELECT 1 as test');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.test).toBe(1);

    // Disconnect
    await expect(client.disconnect()).resolves.not.toThrow();
  });
});
