import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { validateTokenMintForHolderLookup } from '../../apps/bot/src/enrichment';

describe('enrichment mint validation', () => {
  it('rejects Token-2022 mints before calling getTokenLargestAccounts', async () => {
    const connection = {
      getParsedAccountInfo: vi.fn().mockResolvedValue({
        value: {
          data: {
            parsed: {
              info: { type: 'mint', decimals: 9, supply: '1000000000000' },
            },
            program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          },
        },
      }),
    } as unknown as Connection;

    const result = await validateTokenMintForHolderLookup(connection, 'So11111111111111111111111111111111111111112');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('UNSUPPORTED_TOKEN_PROGRAM');
  });
});
