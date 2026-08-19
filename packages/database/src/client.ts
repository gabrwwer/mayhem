
import { Pool, PoolClient, QueryResult } from "pg";

export class DatabaseClient {
  private pool: Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString:
        connectionString ?? process.env["DATABASE_URL"],
    });
  }

  async query<T extends object = object>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
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
        console.error(
          "[DatabaseClient] ROLLBACK failed:",
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }
}