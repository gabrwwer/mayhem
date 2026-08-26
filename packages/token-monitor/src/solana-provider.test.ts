import { describe, it, expect } from 'vitest';
import assert from 'node:assert';
import { SolanaTokenProvider } from './solana-provider';

const pumpProgramId = {
  toBase58: () => '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  equals: () => true,
};
const tokenProgramId = {
  toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};

describe('SolanaTokenProvider.parsePumpFills', () => {
  const provider = new SolanaTokenProvider('https://example.com', { pollingEnabled: true, subscriptionsEnabled: false, batchSize: 1 });

  it('parses a valid pump.fun BUY transaction and extracts mint, buyer, signature, lamports and price', () => {
    const mint = 'Mint111111111111111111111111111111111111111';
    const buyer = 'Buyer1111111111111111111111111111111111111';
    const buf = new Uint8Array(24);
    const maxSolCost = BigInt(200_000_000); // 0.2 SOL in lamports
    new DataView(buf.buffer).setBigUint64(16, maxSolCost, true);

    const tx: any = {
      blockTime: Math.floor(Date.now() / 1000),
      transaction: {
        message: {
          instructions: [
            {
              programId: pumpProgramId,
              data: Buffer.from(buf).toString('base64'),
              accounts: ['g', 'fee', mint, 'bonding', 'assocBond', 'assocUser', buyer],
            },
          ],
          accountKeys: ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', buyer],
        },
      },
      meta: {
        preBalances: [0, 0, 0, 0, 0, 0, 1_000_000_000],
        postBalances: [0, 0, 0, 0, 0, 0, 800_000_000],
        preTokenBalances: [
          { mint, owner: buyer, uiTokenAmount: { uiAmount: 0 } },
        ],
        postTokenBalances: [
          { mint, owner: buyer, uiTokenAmount: { uiAmount: 1000 } },
        ],
      },
    };

    const fills = (provider as any).parsePumpFills(tx, 'SIG1');
    assert.equal(Array.isArray(fills), true);
    assert.equal(fills.length, 1);

    const f = fills[0];
    assert.equal(f.mint, mint);
    assert.equal(f.buyer, buyer);
    assert.equal(f.side, 'buy');
    assert.ok(Math.abs(f.volumeSol - 0.2) < 0.5 * 10 ** -6);
    assert.ok(Math.abs(f.price - 0.0002) < 0.5 * 10 ** -9);
  });

  it('returns empty for unknown/non-pump transactions', () => {
    const tx: any = {
      blockTime: Math.floor(Date.now() / 1000),
      transaction: { message: { instructions: [{ programId: tokenProgramId, data: 'AA==' }], accountKeys: [] } },
      meta: {},
    };

    const fills = (provider as any).parsePumpFills(tx, 'SIG2');
    assert.equal(Array.isArray(fills), true);
    assert.equal(fills.length, 0);
  });
});

