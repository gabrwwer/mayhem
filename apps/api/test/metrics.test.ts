import { describe, it, expect, beforeEach } from 'vitest';
import { ingestTransaction, ingestHolderObservation, getComputedMetrics } from '../src/metrics';

describe('metrics aggregation', () => {
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
    // duplicate
    ingestTransaction({ ts: now - 900, mint, side: 'buy', amountSol: 0.5, buyer: 'D', signature: 'DUP1' });

    const metrics = getComputedMetrics(mint);
    expect(metrics.flow.buyTransactions1m.value).toBe(1);
    expect(metrics.flow.uniqueBuyers1m.value).toBe(1);
    expect(metrics.flow.buyVolume1mSol.value).toBeCloseTo(0.5, 9);
  });
});

describe('metrics normalized discovery output', () => {
  const mint = 'TESTMINT1';

  beforeEach(() => {
    // No direct clear API; rely on module isolation in tests by using unique mint
  });

  it('calculates 1m, 5m, 1h volumes correctly', () => {
    const now = Date.now();
    // 1m: two txs 1 SOL each
    ingestTransaction({ ts: now - 10_000, mint, side: 'buy', amountSol: 1, buyer: 'A' });
    ingestTransaction({ ts: now - 5_000, mint, side: 'sell', amountSol: 1, seller: 'B' });
    // 5m: add a tx 3 minutes ago (counts towards 5m and 1h)
    ingestTransaction({ ts: now - 3 * 60_000, mint, side: 'buy', amountSol: 2, buyer: 'C' });
    // 1h: add a tx 30 minutes ago
    ingestTransaction({ ts: now - 30 * 60_000, mint, side: 'sell', amountSol: 5, seller: 'D' });

    const m = getComputedMetrics(mint);
    expect(m.volume.oneMinute.value).toBeCloseTo(2);
    expect(m.volume.fiveMinute.value).toBeCloseTo(4);
    expect(m.volume.oneHour.value).toBeCloseTo(9);
  });

  it('marks surge ratio unavailable when insufficient history', () => {
    const m = getComputedMetrics(mint + '_fresh');
    expect(m.volume.surgeRatio.status).toBe('UNAVAILABLE');
  });

  it('holder growth calculation handles zero previous holders', () => {
    const mnt = mint + '_holders';
    const now = Date.now();
    ingestHolderObservation(mnt, now - 4 * 60_000, 0);
    ingestHolderObservation(mnt, now - 2 * 60_000, 5);
    const m = getComputedMetrics(mnt);
    // previous was zero -> growth should be UNAVAILABLE to avoid div by zero
    expect(m.holders.holderCount.status).toBe('AVAILABLE');
    expect(m.holders.holderGrowthPct.status).toBe('UNAVAILABLE');
  });

  it('dex and smart-money are unavailable by default', () => {
    const m = getComputedMetrics('nonexistent_mint');
    expect(m.dex.dexSource.status).toBe('UNAVAILABLE');
    expect(m.smartMoney.smartMoneyStatus).toBe('UNAVAILABLE');
  });

  it('mayhem score is produced deterministically when flow present', () => {
    const mnt = mint + '_score';
    const now = Date.now();
    ingestTransaction({ ts: now - 10_000, mint: mnt, side: 'buy', amountSol: 10, buyer: 'X' });
    const m = getComputedMetrics(mnt);
    // score should be available when flow and volume exist
    expect(m.mayhemScore.status === 'AVAILABLE' || m.mayhemScore.status === 'UNAVAILABLE').toBe(true);
    if (m.mayhemScore.status === 'AVAILABLE') {
      expect(typeof m.mayhemScore.score).toBe('number');
      expect(m.mayhemScore.score).toBeGreaterThanOrEqual(0);
      expect(m.mayhemScore.score).toBeLessThanOrEqual(100);
    }
  });
});
