import { describe, it, expect } from 'vitest';
import { ingestTransaction, getComputedMetrics } from '../../apps/api/src/metrics';

describe('metrics aggregation (integration)', () => {
  it('aggregates buys: count, unique buyers, and total volume', () => {
    const mint = 'AggMint11111111111111111111111111111111111';
    const now = Date.now();

    ingestTransaction({ ts: now - 1000, mint, side: 'buy', amountSol: 0.2, buyer: 'A', signature: 'S1' });
    ingestTransaction({ ts: now - 900, mint, side: 'buy', amountSol: 0.35, buyer: 'B', signature: 'S2' });
    ingestTransaction({ ts: now - 800, mint, side: 'buy', amountSol: 0.15, buyer: 'C', signature: 'S3' });

    const metrics = getComputedMetrics(mint);
    expect(metrics.flow.buyTransactions1m.value).toBe(3);
    expect(metrics.flow.uniqueBuyers1m.value).toBe(3);
    expect(metrics.flow.buyVolume1mSol.value).toBeCloseTo(0.7, 9);
  });

  it('deduplicates by signature', () => {
    const mint = 'DedupMint1111111111111111111111111111111111';
    const now = Date.now();
    ingestTransaction({ ts: now - 1000, mint, side: 'buy', amountSol: 0.5, buyer: 'D', signature: 'DUP1' });
    ingestTransaction({ ts: now - 900, mint, side: 'buy', amountSol: 0.5, buyer: 'D', signature: 'DUP1' });

    const metrics = getComputedMetrics(mint);
    expect(metrics.flow.buyTransactions1m.value).toBe(1);
    expect(metrics.flow.uniqueBuyers1m.value).toBe(1);
    expect(metrics.flow.buyVolume1mSol.value).toBeCloseTo(0.5, 9);
  });
});
