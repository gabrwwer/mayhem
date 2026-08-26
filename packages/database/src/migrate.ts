import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { DatabaseClient } from './client';

// During ts-node development migrations are beside this file; when packaged,
// the package keeps the SQL under src/migrations and dist/migrate.js resolves
// the fallback. This prevents a successful no-op production migration.
const MIGRATIONS_DIR = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', 'src', 'migrations'),
].find(fs.existsSync) ?? path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';
const ADVISORY_LOCK_KEY = 0x4d41594548454d; // "MAYHEM" in hex-ish (safe constant)

type Queryable = Pick<PoolClient, 'query'>;

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function ensureMigrationsTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function acquireLock(db: Queryable): Promise<boolean> {
  const res = await db.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [ADVISORY_LOCK_KEY]);
  return !!res.rows[0]?.locked;
}

async function releaseLock(db: Queryable): Promise<void> {
  await db.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
}

async function inTransaction<T>(client: Queryable, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Preserve the migration failure—the rollback failure is only context.
      console.error('[migrate] rollback failed:', rollbackError);
    }
    throw error;
  }
}

async function run(): Promise<void> {
  const db = new DatabaseClient();

  console.info('[migrate] connecting to database');
  await db.connect();

  try {
    await db.withConnection(async (client) => {
      console.info('[migrate] ensuring migrations table');
      await ensureMigrationsTable(client);

      console.info('[migrate] acquiring advisory lock');
      const locked = await acquireLock(client);
      if (!locked) {
        throw new Error('Another migration process is running (could not acquire advisory lock)');
      }

      try {
        const files = listMigrationFiles();
        console.info('[migrate] found', files.length, 'migration(s)');

        for (const file of files) {
          const fullpath = path.join(MIGRATIONS_DIR, file);
          const sql = fs.readFileSync(fullpath, 'utf8');
          const checksum = sha256(sql);

          // Check if already applied
          const existing = await client.query<{ name: string; checksum: string }>(
            `SELECT name, checksum FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
            [file]
          );

          if (existing.rows.length > 0) {
            const row = existing.rows[0]!;
            if (row.checksum !== checksum) {
              throw new Error(`Migration ${file} already applied but checksum differs`);
            }
            console.info(`[migrate] skipping already-applied migration ${file}`);
            continue;
          }

          console.info(`[migrate] applying migration ${file}`);

          // Execute every migration atomically while keeping the advisory lock
          // on the same physical connection for the entire run.
          await inTransaction(client, async () => {
            // client.query accepts multi-statement SQL bodies
            await client.query(sql);

            // Record migration as applied
            await client.query(
              `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
              [file, checksum]
            );
          });

          console.info(`[migrate] migration ${file} applied successfully`);
        }

        console.info('[migrate] all migrations processed');
      } finally {
        console.info('[migrate] releasing advisory lock');
        await releaseLock(client);
      }
    });
  } finally {
    await db.disconnect();
  }
}

export { run };

if (require.main === module) {
  run().catch(err => {
    console.error('[migrate] error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
