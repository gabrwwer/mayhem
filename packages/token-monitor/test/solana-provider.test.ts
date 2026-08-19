import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SolanaTokenProvider } from '../../src/solana-provider';

describe('SolanaTokenProvider.parsePumpFills', () => {
  const provider = new SolanaTokenProvider('https://example.com', { pollingEnabled: false, subscriptionsEnabled: false });

  it('parses a valid pump.fun BUY transaction and extracts mint, buyer, signature, lamports and price', () => {
    const LAMPORTS_PER_SOL = 1_000_000_000;
    const mint = 'Mint111111111111111111111111111111111111111';
    const buyer = 'Buyer1111111111111111111111111111111111111';
    // Build instruction data with maxSolCost at offset 16 (BigUInt64LE)
    const buf = Buffer.alloc(24);
    const maxSolCost = BigInt(200_000_000); // 0.2 SOL in lamports
    buf.writeBigUInt64LE(maxSolCost, 16);

    const tx: any = {
      blockTime: Math.floor(Date.now() / 1000),
      transaction: {
        message: {
          instructions: [
            {
              programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
              data: buf.toString('base64'),
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
    expect(Array.isArray(fills)).toBe(true);
    expect(fills.length).toBe(1);

    const f = fills[0];
    expect(f.mint).toBe(mint);
    expect(f.buyer).toBe(buyer);
    expect(f.side).toBe('buy');
    // lamports spent: 200_000_000 -> 0.2 SOL
    expect(f.volumeSol).toBeCloseTo(0.2, 6);
    // price = volumeSol / tokensOut = 0.2 / 1000
    expect(f.price).toBeCloseTo(0.0002, 9);
  });

  it('returns empty for unknown/non-pump transactions', () => {
    const tx: any = {
      blockTime: Math.floor(Date.now() / 1000),
      transaction: { message: { instructions: [{ programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: 'AA==' }], accountKeys: [] } },
      meta: {},
    };

    const fills = (provider as any).parsePumpFills(tx, 'SIG2');
    expect(Array.isArray(fills)).toBe(true);
    expect(fills.length).toBe(0);
  });
});
