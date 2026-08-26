import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PoolClient } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

// Import the module under test
import { run } from '../migrate';
import { DatabaseClient } from '../client';

describe('Migration runner', () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;
  let disconnectSpy: ReturnType<typeof vi.spyOn>;
  let withConnectionSpy: ReturnType<typeof vi.spyOn>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connectSpy = vi.spyOn(DatabaseClient.prototype, 'connect').mockResolvedValue(undefined);
    disconnectSpy = vi.spyOn(DatabaseClient.prototype, 'disconnect').mockResolvedValue(undefined);

    query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      return { rows: [] };
    });

    withConnectionSpy = vi.spyOn(DatabaseClient.prototype, 'withConnection').mockImplementation(async (fn) => {
      return fn({ query } as unknown as PoolClient);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies pending migrations and records them', async () => {
    await expect(run()).resolves.not.toThrow();

    // connect/disconnect observed
    expect(connectSpy).toHaveBeenCalled();
    expect(disconnectSpy).toHaveBeenCalled();

    expect(withConnectionSpy).toHaveBeenCalledTimes(1);

    // One transaction is required for every migration file. Deriving this
    // from the migration directory verifies the runner contract without
    // making the test stale whenever a new migration is added.
    const migrationCount = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
      .filter((file) => file.endsWith('.sql')).length;
    expect(query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(migrationCount);
    expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(migrationCount);
  });
});
