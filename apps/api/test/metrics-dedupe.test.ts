import { describe, it, expect } from 'vitest';
import { ingestTransaction, computeMetricsForMint } from '../src/metrics';

describe('metrics ingest deduplication', () => {
  it('does not double-count identical signed transactions', () => {
    const mint = 'TestMint';
    const ts = Date.now();
    ingestTransaction({ ts, mint, side: 'buy', amountSol: 1, buyer: 'A', signature: 'SIG1' });
    ingestTransaction({ ts: ts + 10, mint, side: 'buy', amountSol: 1, buyer: 'A', signature: 'SIG1' });

    const metrics = computeMetricsForMint(mint);
    // 1 minute window should show only one transaction of 1 SOL
    expect(metrics.flow.buyTransactions1m.value).toBe(1);
    expect(metrics.flow.buyVolume1mSol.value).toBe(1);
  });
});
