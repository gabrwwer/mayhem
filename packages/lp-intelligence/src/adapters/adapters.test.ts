import { SlotSchema, TimestampSchema, type Slot, type Timestamp } from '@mayhem/core-types';
import { describe, expect, it } from 'vitest';

import { NormalizedPoolSchema } from '../pool.js';
import { captureInitialReserveSnapshot } from '../snapshot.js';
import { PumpFunPoolAdapter, type PumpFunObservation } from './pumpfun.js';
import { RaydiumPoolAdapter, type RaydiumVerifiedPoolLike } from './raydium.js';
import type { AdapterContext } from './types.js';

const NOW: Timestamp = TimestampSchema.parse(1_700_000_000_000);
const SLOT: Slot = SlotSchema.parse(280_000_000);

/** Real base58 mainnet addresses so PublicKeySchema validation is exercised. */
const WSOL = 'So11111111111111111111111111111111111111112';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_VAULT = 'DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz';
const QUOTE_VAULT = 'HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz';
const LP_MINT = '8HoQnePLqPj4M7PUDzfw8e3Ymdwgc7NLGnaTUapubyvu';
const CURVE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

const context: AdapterContext = {
  slot: SLOT,
  txSignature: null,
  observedAt: NOW,
  witnessedInitialization: true,
};

describe('RaydiumPoolAdapter', () => {
  const adapter = new RaydiumPoolAdapter();

  const verified: RaydiumVerifiedPoolLike = {
    poolType: 'amm-v4',
    programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    poolAddress: POOL,
    baseMint: TOKEN,
    quoteMint: WSOL,
    baseVault: BASE_VAULT,
    quoteVault: QUOTE_VAULT,
    lpMint: LP_MINT,
    quoteReserveSol: 42.5,
    poolVerifiedAtMs: 1_700_000_000_000,
  };

  it('normalizes a verified pool into a schema-valid NormalizedPool', () => {
    const result = adapter.normalize(verified, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(NormalizedPoolSchema.safeParse(result.pool).success).toBe(true);
    expect(result.pool.dex).toBe('raydium');
    expect(result.pool.poolType).toBe('amm-v4');
    expect(result.pool.initialization).toBe('INITIALIZED');
  });

  it('records the quote reserve as an on-chain observation', () => {
    const result = adapter.normalize(verified, context);
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.quoteReserve.provenance).toBe('OBSERVED_ONCHAIN');
    expect(result.pool.quoteReserve.value).toBe(42.5);
    expect(result.pool.quoteReserve.slot).toBe(SLOT);
  });

  it('reports the token reserve as unavailable, since the verifier does not decode it', () => {
    const result = adapter.normalize(verified, context);
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.tokenReserve.provenance).toBe('UNAVAILABLE');
    expect(result.pool.tokenReserve.value).toBeNull();
  });

  it('never claims the LP is locked or burned', () => {
    const result = adapter.normalize(verified, context);
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.lpLockOrBurnVerified).toBeNull();
  });

  it('marks reserves unavailable when no slot is known', () => {
    const result = adapter.normalize(verified, { ...context, slot: null });
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.quoteReserve.provenance).toBe('UNAVAILABLE');
    expect(result.pool.liquidity.provenance).toBe('UNAVAILABLE');
  });

  it('rejects an unparseable address rather than guessing', () => {
    const result = adapter.normalize({ ...verified, poolAddress: 'not-base58-0OIl' }, context);
    expect(result.ok).toBe(false);
  });

  it('rejects a negative quote reserve', () => {
    const result = adapter.normalize({ ...verified, quoteReserveSol: -1 }, context);
    expect(result.ok).toBe(false);
  });
});

describe('PumpFunPoolAdapter', () => {
  const adapter = new PumpFunPoolAdapter();

  const observation: PumpFunObservation = {
    tokenMint: TOKEN,
    curveAddress: CURVE,
    quoteMint: WSOL,
    tokenDecimals: 6,
    curve: {
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 5_500_000_000n,
      complete: false,
    },
  };

  it('normalizes a bonding curve into a schema-valid NormalizedPool', () => {
    const result = adapter.normalize(observation, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(NormalizedPoolSchema.safeParse(result.pool).success).toBe(true);
    expect(result.pool.dex).toBe('pumpfun');
    expect(result.pool.poolType).toBe('bonding-curve');
  });

  it('uses real reserves, not virtual ones', () => {
    const result = adapter.normalize(observation, context);
    if (!result.ok) throw new Error('expected normalization to succeed');

    // 5_500_000_000 lamports = 5.5 SOL. The virtual figure is 30 SOL and must
    // not be reported as liquidity — it is a pricing parameter, not a balance.
    expect(result.pool.quoteReserve.value).toBeCloseTo(5.5);
    expect(result.pool.liquidity.value).toBeCloseTo(5.5);
  });

  it('renders the token reserve using the mint decimals', () => {
    const result = adapter.normalize(observation, context);
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.tokenReserve.value).toBeCloseTo(793_100_000);
  });

  it('maps an unreadable complete flag to UNKNOWN, not NOT_INITIALIZED', () => {
    const result = adapter.normalize(
      { ...observation, curve: { ...observation.curve, complete: undefined } },
      context,
    );
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.initialization).toBe('UNKNOWN');
  });

  it('has no vaults or LP mint', () => {
    const result = adapter.normalize(observation, context);
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.baseVault).toBeNull();
    expect(result.pool.quoteVault).toBeNull();
    expect(result.pool.lpMint).toBeNull();
    // "Not applicable" must not read as "verified safe".
    expect(result.pool.lpLockOrBurnVerified).toBeNull();
  });

  it('marks reserves unavailable when no slot is known', () => {
    const result = adapter.normalize(observation, { ...context, slot: null });
    if (!result.ok) throw new Error('expected normalization to succeed');

    expect(result.pool.liquidity.provenance).toBe('UNAVAILABLE');
  });
});

describe('captureInitialReserveSnapshot()', () => {
  const adapter = new PumpFunPoolAdapter();

  const observation: PumpFunObservation = {
    tokenMint: TOKEN,
    curveAddress: CURVE,
    quoteMint: WSOL,
    tokenDecimals: 6,
    curve: {
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 5_500_000_000n,
      complete: false,
    },
  };

  function pool(ctx: AdapterContext = context) {
    const result = adapter.normalize(observation, ctx);
    if (!result.ok) throw new Error('expected normalization to succeed');
    return result.pool;
  }

  it('captures a snapshot when initialization was witnessed', () => {
    const result = captureInitialReserveSnapshot({
      pool: pool(),
      witnessedInitialization: true,
    });

    expect(result.captured).toBe(true);
    if (!result.captured) return;

    expect(result.snapshot.slot).toBe(SLOT);
    expect(result.snapshot.liquidity.value).toBeCloseTo(5.5);
  });

  it('refuses to backfill when the pool was already live when first seen', () => {
    const result = captureInitialReserveSnapshot({
      pool: pool(),
      witnessedInitialization: false,
    });

    expect(result.captured).toBe(false);
    if (result.captured) return;

    expect(result.failure).toBe('POOL_ALREADY_INITIALIZED_BEFORE_OBSERVATION');
  });

  it('refuses when reserves were never observed', () => {
    const result = captureInitialReserveSnapshot({
      pool: pool({ ...context, slot: null }),
      witnessedInitialization: true,
    });

    expect(result.captured).toBe(false);
    if (result.captured) return;

    expect(result.failure).toBe('RESERVES_NOT_OBSERVED');
  });

  it('refuses when initialization state is unknown', () => {
    const unknownPool = adapter.normalize(
      { ...observation, curve: { ...observation.curve, complete: undefined } },
      context,
    );
    if (!unknownPool.ok) throw new Error('expected normalization to succeed');

    const result = captureInitialReserveSnapshot({
      pool: unknownPool.pool,
      witnessedInitialization: true,
    });

    expect(result.captured).toBe(false);
    if (result.captured) return;

    expect(result.failure).toBe('POOL_NOT_INITIALIZED');
  });
});
