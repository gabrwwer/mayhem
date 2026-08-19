import fs from 'fs';
import path from 'path';
import { DatabaseClient, ENGINE_STATE_DDL } from '@mayhem/database';

/**
 * Migration runner.
 *
 * Two bugs were fixed here:
 *
 * 1. `db.transaction(async () => { await db.query(sql) })` ignored the
 *    transactional client and issued the migration through the pool — i.e.
 *    on a DIFFERENT connection from the BEGIN/COMMIT. Migrations were not
 *    atomic: a failure part-way left the schema half-applied with no
 *    `_migrations` row, so a re-run would replay statements against an
 *    already-modified schema.
 *
 * 2. The import and migrations directory resolved to `scripts/packages/...`
 *    rather than the repo's `packages/...`, so the script could not run at
 *    all from its own location.
 */
async function migrate(): Promise<void> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const db = new DatabaseClient(dbUrl);
  await db.connect();

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Durable engine state (circuit breaker + open positions). Applied
    // here rather than as a numbered migration because the bot calls
    // ensureSchema() at boot too, and both paths must be idempotent.
    await db.query(ENGINE_STATE_DDL);

    const migrationsDir = path.resolve(
      __dirname,
      '..',
      '..',
      'packages',
      'database',
      'src',
      'migrations',
    );

    if (!fs.existsSync(migrationsDir)) {
      console.log(`No migrations directory at ${migrationsDir}; schema is up to date`);
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied = await db.query<{ name: string }>('SELECT name FROM _migrations');
    const appliedNames = new Set(applied.rows.map((r) => r.name));

    for (const file of files) {
      if (appliedNames.has(file)) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      console.log(`Applying ${file}...`);

      // Use the transactional client for BOTH statements so the migration
      // and its bookkeeping row commit or roll back together.
      await db.transaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      });

      console.log(`Applied ${file}`);
    }

    console.log('Migrations complete');
  } finally {
    await db.disconnect();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
