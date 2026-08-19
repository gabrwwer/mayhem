
import { DatabaseClient } from "./client";
import {
  DbToken,
  DbLaunch,
  DbPool,
  DbTrade,
  DbPosition,
  DbTransaction,
  DbRiskEvent,
  DbBotEvent,
  DbWalletBalance,
  DbAuditLog,
} from "./types";

/**
 * Postgres identifiers cannot be parameterised, so any identifier that
 * reaches SQL must be validated rather than interpolated blind. `insert`
 * and `update` below build column lists from `Object.keys(data)`; if that
 * object ever originates from a request body (and `state.ts` stores request
 * payloads as `any`), unvalidated keys are a direct SQL injection.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

abstract class BaseRepository<T extends object> {
  constructor(
    protected readonly db: DatabaseClient,
    protected readonly table: string
  ) {
    // Fail at construction, not at first query.
    quoteIdentifier(table);
  }

  async findById(id: string): Promise<T | null> {
    const result = await this.db.query<T>(
      `SELECT * FROM ${quoteIdentifier(this.table)} WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findAll(limit = 100, offset = 0): Promise<T[]> {
    const result = await this.db.query<T>(
      `SELECT * FROM ${quoteIdentifier(this.table)} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  }

  async insert(data: Omit<T, "id">): Promise<T> {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      throw new Error(`insert into ${this.table} requires at least one column`);
    }
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const columns = keys.map(quoteIdentifier).join(", ");
    const result = await this.db.query<T>(
      `INSERT INTO ${quoteIdentifier(this.table)} (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return result.rows[0]!;
  }

  async update(id: string, data: Partial<T>): Promise<T | null> {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      throw new Error(`update on ${this.table} requires at least one column`);
    }
    const values = Object.values(data);
    const sets = keys
      .map((k, i) => `${quoteIdentifier(k)} = $${i + 2}`)
      .join(", ");
    const result = await this.db.query<T>(
      `UPDATE ${quoteIdentifier(this.table)} SET ${sets} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    return result.rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM ${quoteIdentifier(this.table)} WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export class TokenRepository extends BaseRepository<DbToken> {
  constructor(db: DatabaseClient) {
    super(db, "tokens");
  }

  async findByMint(mintAddress: string): Promise<DbToken | null> {
    const result = await this.db.query<DbToken>(
      `SELECT * FROM tokens WHERE mint_address = $1`,
      [mintAddress]
    );
    return result.rows[0] ?? null;
  }

  async findByCreator(creator: string): Promise<DbToken[]> {
    const result = await this.db.query<DbToken>(
      `SELECT * FROM tokens WHERE creator = $1 ORDER BY created_at DESC`,
      [creator]
    );
    return result.rows;
  }
}

export class LaunchRepository extends BaseRepository<DbLaunch> {
  constructor(db: DatabaseClient) {
    super(db, "launches");
  }

  async findByPlatform(platform: string): Promise<DbLaunch[]> {
    const result = await this.db.query<DbLaunch>(
      `SELECT * FROM launches WHERE platform = $1 ORDER BY launch_time DESC`,
      [platform]
    );
    return result.rows;
  }

  async findByStatus(status: string): Promise<DbLaunch[]> {
    const result = await this.db.query<DbLaunch>(
      `SELECT * FROM launches WHERE status = $1 ORDER BY launch_time DESC`,
      [status]
    );
    return result.rows;
  }

  async findByTokenId(tokenId: string): Promise<DbLaunch | null> {
    const result = await this.db.query<DbLaunch>(
      `SELECT * FROM launches WHERE token_id = $1`,
      [tokenId]
    );
    return result.rows[0] ?? null;
  }
}

export class PoolRepository extends BaseRepository<DbPool> {
  constructor(db: DatabaseClient) {
    super(db, "pools");
  }

  async findByAddress(address: string): Promise<DbPool | null> {
    const result = await this.db.query<DbPool>(
      `SELECT * FROM pools WHERE address = $1`,
      [address]
    );
    return result.rows[0] ?? null;
  }

  async findByTokenMint(tokenMint: string): Promise<DbPool[]> {
    const result = await this.db.query<DbPool>(
      `SELECT * FROM pools WHERE token_mint = $1 ORDER BY last_updated DESC`,
      [tokenMint]
    );
    return result.rows;
  }

  async findActive(): Promise<DbPool[]> {
    const result = await this.db.query<DbPool>(
      `SELECT * FROM pools WHERE status = 'active' ORDER BY liquidity DESC`
    );
    return result.rows;
  }
}

export class TradeRepository extends BaseRepository<DbTrade> {
  constructor(db: DatabaseClient) {
    super(db, "trades");
  }

  async findByPosition(positionId: string): Promise<DbTrade[]> {
    const result = await this.db.query<DbTrade>(
      `SELECT * FROM trades WHERE position_id = $1 ORDER BY created_at ASC`,
      [positionId]
    );
    return result.rows;
  }

  async findByTokenMint(tokenMint: string): Promise<DbTrade[]> {
    const result = await this.db.query<DbTrade>(
      `SELECT * FROM trades WHERE token_mint = $1 ORDER BY created_at DESC`,
      [tokenMint]
    );
    return result.rows;
  }

  async findByTxSignature(txSignature: string): Promise<DbTrade | null> {
    const result = await this.db.query<DbTrade>(
      `SELECT * FROM trades WHERE tx_signature = $1`,
      [txSignature]
    );
    return result.rows[0] ?? null;
  }
}

export class PositionRepository extends BaseRepository<DbPosition> {
  constructor(db: DatabaseClient) {
    super(db, "positions");
  }

  async findOpen(): Promise<DbPosition[]> {
    const result = await this.db.query<DbPosition>(
      `SELECT * FROM positions WHERE status = 'open' ORDER BY entry_time DESC`
    );
    return result.rows;
  }

  async findClosed(): Promise<DbPosition[]> {
    const result = await this.db.query<DbPosition>(
      `SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC`
    );
    return result.rows;
  }

  async findByTokenMint(tokenMint: string): Promise<DbPosition[]> {
    const result = await this.db.query<DbPosition>(
      `SELECT * FROM positions WHERE token_mint = $1 ORDER BY entry_time DESC`,
      [tokenMint]
    );
    return result.rows;
  }
}

export class TransactionRepository extends BaseRepository<DbTransaction> {
  constructor(db: DatabaseClient) {
    super(db, "transactions");
  }

  async findPending(): Promise<DbTransaction[]> {
    const result = await this.db.query<DbTransaction>(
      `SELECT * FROM transactions WHERE status = 'pending' ORDER BY created_at ASC`
    );
    return result.rows;
  }

  async findBySignature(txSignature: string): Promise<DbTransaction | null> {
    const result = await this.db.query<DbTransaction>(
      `SELECT * FROM transactions WHERE tx_signature = $1`,
      [txSignature]
    );
    return result.rows[0] ?? null;
  }

  async findByTokenMint(tokenMint: string): Promise<DbTransaction[]> {
    const result = await this.db.query<DbTransaction>(
      `SELECT * FROM transactions WHERE token_mint = $1 ORDER BY created_at DESC`,
      [tokenMint]
    );
    return result.rows;
  }
}

export class RiskEventRepository extends BaseRepository<DbRiskEvent> {
  constructor(db: DatabaseClient) {
    super(db, "risk_events");
  }

  async findByTokenMint(tokenMint: string): Promise<DbRiskEvent[]> {
    const result = await this.db.query<DbRiskEvent>(
      `SELECT * FROM risk_events WHERE token_mint = $1 ORDER BY created_at DESC`,
      [tokenMint]
    );
    return result.rows;
  }

  async findBySeverity(severity: string): Promise<DbRiskEvent[]> {
    const result = await this.db.query<DbRiskEvent>(
      `SELECT * FROM risk_events WHERE severity = $1 ORDER BY created_at DESC`,
      [severity]
    );
    return result.rows;
  }
}

export class BotEventRepository extends BaseRepository<DbBotEvent> {
  constructor(db: DatabaseClient) {
    super(db, "bot_events");
  }

  async findByType(eventType: string): Promise<DbBotEvent[]> {
    const result = await this.db.query<DbBotEvent>(
      `SELECT * FROM bot_events WHERE event_type = $1 ORDER BY created_at DESC`,
      [eventType]
    );
    return result.rows;
  }
}

export class WalletBalanceRepository extends BaseRepository<DbWalletBalance> {
  constructor(db: DatabaseClient) {
    super(db, "wallet_balances");
  }

  async findLatest(): Promise<DbWalletBalance | null> {
    const result = await this.db.query<DbWalletBalance>(
      `SELECT * FROM wallet_balances ORDER BY updated_at DESC LIMIT 1`
    );
    return result.rows[0] ?? null;
  }
}

export class AuditLogRepository extends BaseRepository<DbAuditLog> {
  constructor(db: DatabaseClient) {
    super(db, "audit_logs");
  }

  async findByAction(action: string): Promise<DbAuditLog[]> {
    const result = await this.db.query<DbAuditLog>(
      `SELECT * FROM audit_logs WHERE action = $1 ORDER BY created_at DESC`,
      [action]
    );
    return result.rows;
  }

  async findByActor(actor: string): Promise<DbAuditLog[]> {
    const result = await this.db.query<DbAuditLog>(
      `SELECT * FROM audit_logs WHERE actor = $1 ORDER BY created_at DESC`,
      [actor]
    );
    return result.rows;
  }
}