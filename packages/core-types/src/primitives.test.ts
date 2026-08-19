
import { describe, expect, it } from 'vitest';
import {
  PublicKeySchema,
  RawAmountSchema,
  TokenAmountSchema,
  TransactionSignatureSchema,
  formatTokenAmount,
} from './primitives.js';

const WSOL = 'So11111111111111111111111111111111111111112';

describe('PublicKeySchema', () => {
  it('accepts a base58 mint address', () => {
    expect(PublicKeySchema.parse(WSOL)).toBe(WSOL);
  });

  it.each([
    ['too short', 'abc'],
    ['contains 0', `0${WSOL.slice(1)}`],
    ['contains O', `O${WSOL.slice(1)}`],
    ['contains l', `l${WSOL.slice(1)}`],
    ['hex-style 0x address', '0x1234567890abcdef1234567890abcdef12345678'],
  ])('rejects a key that is %s', (_label, value) => {
    expect(PublicKeySchema.safeParse(value).success).toBe(false);
  });
});

describe('TransactionSignatureSchema', () => {
  it('rejects a value of the wrong length', () => {
    expect(TransactionSignatureSchema.safeParse(WSOL).success).toBe(false);
  });
});

describe('RawAmountSchema', () => {
  it('preserves precision beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '18446744073709551615';
    expect(RawAmountSchema.parse(huge)).toBe(18_446_744_073_709_551_615n);
  });

  it('accepts a bigint unchanged', () => {
    expect(RawAmountSchema.parse(42n)).toBe(42n);
  });

  it.each([['-1'], ['1.5'], ['1e9'], ['']])('rejects %s', (value) => {
    expect(RawAmountSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a negative bigint', () => {
    expect(RawAmountSchema.safeParse(-1n).success).toBe(false);
  });
});

describe('formatTokenAmount', () => {
  const amount = (raw: bigint, decimals: number) =>
    TokenAmountSchema.parse({ mint: WSOL, raw, decimals });

  it.each([
    [1_500_000_000n, 9, '1.5'],
    [1_000_000_000n, 9, '1'],
    [1n, 9, '0.000000001'],
    [0n, 9, '0'],
    [123n, 0, '123'],
    [1_000_000_000_000_000_000_000n, 9, '1000000000000'],
  ])('renders %s raw at %i decimals as %s', (raw, decimals, expected) => {
    expect(formatTokenAmount(amount(raw, decimals))).toBe(expected);
  });
});