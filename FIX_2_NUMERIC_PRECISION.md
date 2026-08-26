# FIX #2: DATABASE NUMERIC PRECISION

## Problem
DOUBLE PRECISION for amounts causes rounding errors. A 1,000,000 lamport transaction might round to 999,999 or 1,000,001. Over hundreds of trades, this compounds into audit failures and PnL discrepancies.

## Root Cause
PostgreSQL schema uses DOUBLE PRECISION (IEEE 754 64-bit float) for all amount columns:
- `balances.amount DOUBLE PRECISION` - SOL/token balances
- `trades.size DOUBLE PRECISION` - Trade quantities
- `trades.value DOUBLE PRECISION` - Trade values in SOL
- Solana amounts are integers in lamports (1 SOL = 10^9 lamports)
- Floats cannot exactly represent all integers > 2^53 (9.0e15)
- Over time: rounding errors accumulate → audit trail diverges from on-chain reality

## Implementation Strategy

### 1. Data Migration SQL
**File**: `packages/database/src/migrations/003_numeric_precision.sql`

This migration:
1. Creates new columns with NUMERIC(20,8) type
2. Copies and converts existing data
3. Drops old columns (after testing)
4. Renames new columns to original names

```sql
-- ============================================================================
-- Migration: Convert DOUBLE PRECISION amounts to NUMERIC(20,8) for accuracy
-- ============================================================================
-- NUMERIC(20,8) provides:
--   - 20 total digits, 8 decimal places
--   - Exact representation up to 99,999,999,999.99999999
--   - Safe for all Solana amounts (max 9.2B SOL = 9.2e18 lamports)

-- Step 1: Add new NUMERIC columns alongside existing DOUBLE columns
ALTER TABLE trades ADD COLUMN size_numeric NUMERIC(20,8);
ALTER TABLE trades ADD COLUMN value_numeric NUMERIC(20,8);
ALTER TABLE trades ADD COLUMN entry_price_numeric NUMERIC(20,8);
ALTER TABLE trades ADD COLUMN exit_price_numeric NUMERIC(20,8);

ALTER TABLE wallet_balances ADD COLUMN amount_numeric NUMERIC(20,8);
ALTER TABLE wallet_balances ADD COLUMN sol_value_numeric NUMERIC(20,8);

ALTER TABLE positions ADD COLUMN size_numeric NUMERIC(20,8);
ALTER TABLE positions ADD COLUMN entry_price_numeric NUMERIC(20,8);
ALTER TABLE positions ADD COLUMN current_price_numeric NUMERIC(20,8);
ALTER TABLE positions ADD COLUMN exit_price_numeric NUMERIC(20,8);

ALTER TABLE risk_events ADD COLUMN amount_numeric NUMERIC(20,8);

-- Step 2: Copy and convert existing data
-- Use CAST to convert DOUBLE to NUMERIC (implicit truncation)
UPDATE trades 
  SET size_numeric = CAST(size AS NUMERIC(20,8))
  WHERE size_numeric IS NULL;

UPDATE trades 
  SET value_numeric = CAST(value AS NUMERIC(20,8))
  WHERE value_numeric IS NULL;

UPDATE trades 
  SET entry_price_numeric = CAST(entry_price AS NUMERIC(20,8))
  WHERE entry_price_numeric IS NULL;

UPDATE trades 
  SET exit_price_numeric = CAST(exit_price AS NUMERIC(20,8))
  WHERE exit_price_numeric IS NULL;

UPDATE wallet_balances 
  SET amount_numeric = CAST(amount AS NUMERIC(20,8))
  WHERE amount_numeric IS NULL;

UPDATE wallet_balances 
  SET sol_value_numeric = CAST(sol_value AS NUMERIC(20,8))
  WHERE sol_value_numeric IS NULL;

UPDATE positions 
  SET size_numeric = CAST(size AS NUMERIC(20,8))
  WHERE size_numeric IS NULL;

UPDATE positions 
  SET entry_price_numeric = CAST(entry_price AS NUMERIC(20,8))
  WHERE entry_price_numeric IS NULL;

UPDATE positions 
  SET current_price_numeric = CAST(current_price AS NUMERIC(20,8))
  WHERE current_price_numeric IS NULL;

UPDATE positions 
  SET exit_price_numeric = CAST(exit_price AS NUMERIC(20,8))
  WHERE exit_price_numeric IS NULL;

UPDATE risk_events 
  SET amount_numeric = CAST(amount AS NUMERIC(20,8))
  WHERE amount_numeric IS NULL;

-- Step 3: Verify data integrity (sample check)
-- If any differences, investigate before proceeding
-- SELECT id, size, size_numeric FROM trades WHERE size != CAST(size_numeric AS DOUBLE PRECISION) LIMIT 10;

-- Step 4: Drop old DOUBLE PRECISION columns
ALTER TABLE trades DROP COLUMN size CASCADE;
ALTER TABLE trades DROP COLUMN value CASCADE;
ALTER TABLE trades DROP COLUMN entry_price CASCADE;
ALTER TABLE trades DROP COLUMN exit_price CASCADE;

ALTER TABLE wallet_balances DROP COLUMN amount CASCADE;
ALTER TABLE wallet_balances DROP COLUMN sol_value CASCADE;

ALTER TABLE positions DROP COLUMN size CASCADE;
ALTER TABLE positions DROP COLUMN entry_price CASCADE;
ALTER TABLE positions DROP COLUMN current_price CASCADE;
ALTER TABLE positions DROP COLUMN exit_price CASCADE;

ALTER TABLE risk_events DROP COLUMN amount CASCADE;

-- Step 5: Rename new columns to original names
ALTER TABLE trades RENAME COLUMN size_numeric TO size;
ALTER TABLE trades RENAME COLUMN value_numeric TO value;
ALTER TABLE trades RENAME COLUMN entry_price_numeric TO entry_price;
ALTER TABLE trades RENAME COLUMN exit_price_numeric TO exit_price;

ALTER TABLE wallet_balances RENAME COLUMN amount_numeric TO amount;
ALTER TABLE wallet_balances RENAME COLUMN sol_value_numeric TO sol_value;

ALTER TABLE positions RENAME COLUMN size_numeric TO size;
ALTER TABLE positions RENAME COLUMN entry_price_numeric TO entry_price;
ALTER TABLE positions RENAME COLUMN current_price_numeric TO current_price;
ALTER TABLE positions RENAME COLUMN exit_price_numeric TO exit_price;

ALTER TABLE risk_events RENAME COLUMN amount_numeric TO amount;

-- Step 6: Update column constraints (NOT NULL where applicable)
-- These should have been preserved, but verify after migration
ALTER TABLE trades ALTER COLUMN size SET NOT NULL;
ALTER TABLE wallet_balances ALTER COLUMN amount SET NOT NULL;
ALTER TABLE positions ALTER COLUMN size SET NOT NULL;

-- Step 7: Create or update indexes (optional, but recommended)
-- Indexes may need recreation after column changes
REINDEX TABLE trades;
REINDEX TABLE wallet_balances;
REINDEX TABLE positions;
REINDEX TABLE risk_events;

-- Step 8: Log migration completion
INSERT INTO schema_migrations (version, description, executed_at) 
  VALUES ('003', 'Convert DOUBLE PRECISION to NUMERIC(20,8)', now())
  ON CONFLICT DO NOTHING;
```

### 2. Update TypeScript Types
**File**: `packages/database/src/types.ts`

Update all amount-related types to use `string` (since NUMERIC is returned as string by node-pg):

```typescript
// Before
export interface Trade {
  id: string;
  size: number;           // DOUBLE PRECISION
  value: number;          // DOUBLE PRECISION
  entryPrice: number;     // DOUBLE PRECISION
  exitPrice: number;      // DOUBLE PRECISION
}

// After
export interface Trade {
  id: string;
  size: string;           // NUMERIC(20,8) - returned as string
  value: string;          // NUMERIC(20,8) - returned as string
  entryPrice: string;     // NUMERIC(20,8) - returned as string
  exitPrice: string;      // NUMERIC(20,8) - returned as string
}

export interface Position {
  id: string;
  size: string;           // NUMERIC(20,8)
  entryPrice: string;     // NUMERIC(20,8)
  currentPrice: string;   // NUMERIC(20,8)
  exitPrice?: string;     // NUMERIC(20,8)
}

export interface WalletBalance {
  id: string;
  amount: string;         // NUMERIC(20,8) - lamports or smallest unit
  solValue: string;       // NUMERIC(20,8) - SOL equivalent
  updatedAt: Date;
}

export interface RiskEvent {
  id: string;
  amount?: string;        // NUMERIC(20,8)
}
```

### 3. Update SQL Queries in Repositories
**File**: `packages/database/src/repositories.ts`

Example updates:

```typescript
// Before: SELECT size FROM trades
// After: SELECT size::text FROM trades  (explicit cast for type safety)

export class TradeRepository {
  async getByDateRange(startDate: Date, endDate: Date): Promise<Trade[]> {
    const result = await this.db.query<Trade>(
      `SELECT 
         id, 
         mint,
         size::text,           -- Cast NUMERIC to string
         value::text,
         entry_price::text,
         exit_price::text,
         filled_at
       FROM trades
       WHERE filled_at BETWEEN $1 AND $2
       ORDER BY filled_at DESC`,
      [startDate, endDate],
    );
    return result.rows;
  }

  async getTotalVolume(mint: string): Promise<string> {
    const result = await this.db.query<{ total: string }>(
      `SELECT SUM(size)::numeric(20,8)::text as total
       FROM trades
       WHERE mint = $1`,
      [mint],
    );
    return result.rows[0]?.total ?? '0';
  }
}

export class PositionRepository {
  async getOpen(): Promise<Position[]> {
    const result = await this.db.query<Position>(
      `SELECT 
         id,
         mint,
         size::text,
         entry_price::text,
         current_price::text,
         exit_price::text
       FROM positions
       WHERE closed_at IS NULL`,
    );
    return result.rows;
  }
}
```

### 4. Update Trading Engine for String Amounts
**File**: `packages/trading-engine/src/calculations.ts`

Add helper functions for NUMERIC string operations:

```typescript
/**
 * Safe arithmetic on NUMERIC strings (from database)
 * NUMERIC(20,8) strings can have up to 12 integer digits and 8 decimal places
 */

import Decimal from 'decimal.js';

export function parseAmount(amount: string | number): Decimal {
  return new Decimal(String(amount));
}

export function formatAmount(decimal: Decimal, decimals = 8): string {
  return decimal.toFixed(decimals);
}

export function addAmounts(...amounts: (string | number)[]): string {
  return amounts.reduce((sum, amt) => 
    parseAmount(sum).plus(parseAmount(amt)).toString(),
    '0'
  );
}

export function subtractAmounts(a: string | number, b: string | number): string {
  return parseAmount(a).minus(parseAmount(b)).toString();
}

export function multiplyAmounts(a: string | number, b: string | number): string {
  return parseAmount(a).times(parseAmount(b)).toString();
}

export function divideAmounts(a: string | number, b: string | number): string {
  return parseAmount(a).dividedBy(parseAmount(b)).toString();
}

export function calculatePnL(
  entryPrice: string,
  exitPrice: string,
  size: string,
): string {
  // PnL = (exitPrice - entryPrice) * size
  return multiplyAmounts(
    subtractAmounts(exitPrice, entryPrice),
    size,
  );
}

// Example usage in trading engine
export function calculateRealizedPnL(positions: Position[]): {
  totalPnL: string;
  byMint: Record<string, string>;
} {
  const byMint: Record<string, string> = {};
  
  for (const pos of positions) {
    if (!pos.exitPrice) continue;
    
    const pnl = calculatePnL(pos.entryPrice, pos.exitPrice, pos.size);
    byMint[pos.mint] = (byMint[pos.mint] ?? '0') + parseAmount(pnl).toString();
  }
  
  const totalPnL = Object.values(byMint).reduce(
    (sum, pnl) => addAmounts(sum, pnl),
    '0'
  );
  
  return { totalPnL, byMint };
}
```

### 5. Install Decimal.js for safe arithmetic
**File**: `package.json` (root)

```json
{
  "dependencies": {
    "decimal.js": "^10.4.3"
  }
}
```

Then run: `pnpm install`

## Test Cases

**File**: `packages/database/src/__tests__/numeric-precision.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DatabaseClient } from '../client';

describe('Numeric Precision Migration', () => {
  let db: DatabaseClient;
  let pool: Pool;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set');
    
    pool = new Pool({ connectionString });
    db = new DatabaseClient(connectionString);
    
    // Run migration
    const migrationSQL = fs.readFileSync(
      'packages/database/src/migrations/003_numeric_precision.sql',
      'utf-8'
    );
    await db.query(migrationSQL);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should store and retrieve NUMERIC amounts without rounding', async () => {
    // Insert a precise amount
    const amount = '1000000.12345678'; // 1M lamports with decimals
    
    await db.query(
      `INSERT INTO wallet_balances (wallet_id, amount, created_at)
       VALUES ($1, $2::numeric, now())`,
      ['test-wallet', amount],
    );
    
    const result = await db.query<{ amount: string }>(
      `SELECT amount::text FROM wallet_balances WHERE wallet_id = $1`,
      ['test-wallet'],
    );
    
    expect(result.rows[0].amount).toBe(amount);
  });

  it('should handle large lamport amounts', async () => {
    // 9.2 billion SOL = 9.2e18 lamports
    const largeAmount = '9200000000000000000'; // 9.2B SOL in lamports
    
    await db.query(
      `INSERT INTO positions (mint, size, created_at)
       VALUES ($1, $2::numeric, now())`,
      ['EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d', largeAmount],
    );
    
    const result = await db.query<{ size: string }>(
      `SELECT size::text FROM positions WHERE mint = $1`,
      ['EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d'],
    );
    
    expect(result.rows[0].size).toBe(largeAmount);
  });

  it('should preserve precision in calculations', async () => {
    const price1 = '0.00000002'; // 2e-8 SOL
    const price2 = '0.00000003'; // 3e-8 SOL
    
    const result = await db.query<{ sum: string }>(
      `SELECT ($1::numeric + $2::numeric)::text as sum`,
      [price1, price2],
    );
    
    expect(result.rows[0].sum).toBe('0.00000005');
  });

  it('should not have precision loss on double cast', async () => {
    // This test verifies that casting from DOUBLE to NUMERIC preserves
    // the best approximation the DOUBLE had
    const testValue = '1000000';
    
    // Insert via DOUBLE (old way), retrieve as NUMERIC
    await db.query(
      `INSERT INTO trades (size, created_at) 
       VALUES ($1::double precision, now())`,
      [testValue],
    );
    
    const result = await db.query<{ size: string }>(
      `SELECT size::text FROM trades WHERE size::text LIKE $1`,
      ['%1000000%'],
    );
    
    // The value should be close to original (may have DOUBLE rounding)
    const retrieved = parseFloat(result.rows[0].size);
    expect(Math.abs(retrieved - parseFloat(testValue))).toBeLessThan(1);
  });
});
```

**File**: `packages/trading-engine/src/__tests__/amount-calculations.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseAmount,
  formatAmount,
  addAmounts,
  multiplyAmounts,
  calculatePnL,
} from '../calculations';

describe('Safe Amount Calculations', () => {
  it('should add NUMERIC amounts without precision loss', () => {
    const result = addAmounts('0.00000001', '0.00000002');
    expect(result).toBe('0.00000003');
  });

  it('should multiply large amounts exactly', () => {
    // 1M tokens at 0.001 SOL each = 1000 SOL
    const result = multiplyAmounts('1000000', '0.001');
    expect(result).toBe('1000');
  });

  it('should calculate PnL correctly', () => {
    // Buy 1000 tokens at 0.01 SOL, sell at 0.02 SOL
    // PnL = (0.02 - 0.01) * 1000 = 10 SOL
    const pnl = calculatePnL('0.01', '0.02', '1000');
    expect(pnl).toBe('10');
  });

  it('should format amounts to 8 decimals', () => {
    const formatted = formatAmount(parseAmount('0.123456789'), 8);
    expect(formatted).toBe('0.12345679'); // rounded to 8 decimals
  });
});
```

## Deployment Notes

1. **Backup database before migration**:
   ```bash
   pg_dump $DATABASE_URL > mayhem_backup_pre_numeric.sql
   ```

2. **Run migration** (production):
   ```bash
   psql $DATABASE_URL < packages/database/src/migrations/003_numeric_precision.sql
   ```

3. **Verify data integrity**:
   ```sql
   -- Check for any significant deviations
   SELECT COUNT(*) FROM trades WHERE size IS NULL;
   SELECT COUNT(*) FROM positions WHERE size IS NULL;
   ```

4. **Update application code**:
   - Install `decimal.js`: `pnpm install`
   - Deploy new code that treats amounts as strings
   - Restart bot

5. **Rollback** (if needed):
   ```sql
   -- Create reversed migration with DOUBLE columns
   -- Restore from backup: psql $DATABASE_URL < mayhem_backup_pre_numeric.sql
   ```

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Query timeout during conversion | Medium | High | Run during low-traffic period |
| Application crashes on amount type change | Medium | High | Test with sample data first |
| Data loss due to precision loss | Low | Critical | Backup before migration |
| Index performance degradation | Low | Medium | REINDEX tables after migration |

**Rollback Strategy**:
- Keep backup for 7 days
- Have DOUBLE-based schema ready as fallback
- Use feature flags: `USE_NUMERIC_AMOUNTS=true/false`

**Monitoring**:
- Track query execution times (should not increase)
- Monitor for type conversion errors in application logs
- Verify PnL calculations match pre-migration values
