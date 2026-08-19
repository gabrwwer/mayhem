
import { describe, expect, it } from 'vitest';
import { PnlSnapshotSchema, ReconciliationResultSchema, netPnlLamports } from './positions.js';

const WSOL = 'So11111111111111111111111111111111111111112';

describe('netPnlLamports', () => {
  const snapshot = (overrides: Record<string, unknown>) =>
    PnlSnapshotSchema.parse({
      strategyId: 'launch-snipe',
      asOf: 1_700_000_000_000,
      realizedLamports: 0n,
      unrealizedLamports: 0n,
      feesLamports: 0n,
      gasLamports: 0n,
      ...overrides,
    });

  it('subtracts fees and gas from gross profit', () => {
    const pnl = netPnlLamports(
      snapshot({
        realizedLamports: 1_000_000n,
        unrealizedLamports: 500_000n,
        feesLamports: 300_000n,
        gasLamports: 200_000n,
      }),
    );
    expect(pnl).toBe(1_000_000n);
  });

  it('reports a loss when costs exceed gross profit', () => {
    const pnl = netPnlLamports(
      snapshot({ realizedLamports: 100_000n, feesLamports: 80_000n, gasLamports: 50_000n }),
    );
    expect(pnl).toBe(-30_000n);
  });

  it('allows realized P&L to be negative', () => {
    expect(netPnlLamports(snapshot({ realizedLamports: -1n }))).toBe(-1n);
  });

  it('rejects negative fees', () => {
    expect(
      PnlSnapshotSchema.safeParse({
        strategyId: 'launch-snipe',
        asOf: 1_700_000_000_000,
        realizedLamports: 0n,
        unrealizedLamports: 0n,
        feesLamports: -1n,
        gasLamports: 0n,
      }).success,
    ).toBe(false);
  });
});

describe('ReconciliationResultSchema', () => {
  const base = {
    reconciledAt: 1_700_000_000_000,
    mint: WSOL,
    localQuantityRaw: '1000',
    onChainQuantityRaw: '1000',
  };

  it('accepts a matching reconciliation', () => {
    expect(ReconciliationResultSchema.parse({ ...base, drifted: false }).drifted).toBe(false);
  });

  it('refuses to record a mismatch as undrifted', () => {
    const result = ReconciliationResultSchema.safeParse({
      ...base,
      onChainQuantityRaw: '999',
      drifted: false,
    });
    expect(result.success).toBe(false);
  });

  it('refuses to record a match as drifted', () => {
    expect(ReconciliationResultSchema.safeParse({ ...base, drifted: true }).success).toBe(false);
  });
});