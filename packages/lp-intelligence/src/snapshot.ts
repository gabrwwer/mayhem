import { z } from 'zod';
import {
  PublicKeySchema,
  SlotSchema,
  TimestampSchema,
  TransactionSignatureSchema,
  type PublicKey,
  type Slot,
  type Timestamp,
  type TransactionSignature,
} from '@mayhem/core-types';
import { DexSchema, type Dex, type NormalizedPool } from './pool.js';
import { ObservedNumberSchema, isObservedOnChain, type Observed } from './provenance.js';

/**
 * The earliest reliable reserve state for a pool.
 *
 * This is the baseline every later liquidity comparison is measured against,
 * which is why it may only ever be built from a genuine on-chain observation.
 * A fabricated or back-filled baseline does not merely produce a wrong
 * percentage — it produces a *confident* wrong percentage, and a "liquidity
 * unchanged" reading on a pool that was quietly drained before we started
 * watching is precisely the failure this type exists to prevent.
 */
export interface InitialReserveSnapshot {
  poolAddress: PublicKey;
  tokenMint: PublicKey;
  quoteMint: PublicKey;
  dex: Dex;

  /** Token-side reserve at capture, in whole tokens. */
  tokenReserve: Observed<number>;
  /** Quote-side reserve at capture, in whole quote tokens (SOL). */
  quoteReserve: Observed<number>;
  /** Total liquidity in quote terms (SOL) at capture. */
  liquidity: Observed<number>;

  /** Slot the snapshot was read at. Non-null by construction. */
  slot: Slot;
  txSignature: TransactionSignature | null;
  observedAt: Timestamp;
  source: string;
}

export const InitialReserveSnapshotSchema = z
  .object({
    poolAddress: PublicKeySchema,
    tokenMint: PublicKeySchema,
    quoteMint: PublicKeySchema,
    dex: DexSchema,
    tokenReserve: ObservedNumberSchema,
    quoteReserve: ObservedNumberSchema,
    liquidity: ObservedNumberSchema,
    slot: SlotSchema,
    txSignature: TransactionSignatureSchema.nullable(),
    observedAt: TimestampSchema,
    source: z.string().min(1).max(200),
  })
  .strict()
  .refine((s) => s.liquidity.provenance === 'OBSERVED_ONCHAIN', {
    message:
      'an initial reserve snapshot must be built from an on-chain observation, never an estimate',
    path: ['liquidity'],
  });

/**
 * Why a snapshot could not be captured.
 *
 * `POOL_ALREADY_INITIALIZED_BEFORE_OBSERVATION` is the important one: it
 * records that the pool was already live when we first saw it, so no initial
 * state exists to capture. That is a permanent, factual property of this
 * pool — not a transient error — and it is what
 * `REQUIRE_INITIAL_RESERVE_SNAPSHOT` will key off in Phase 9.
 */
export const SnapshotFailureSchema = z.enum([
  'RESERVES_NOT_OBSERVED',
  'RESERVES_ESTIMATED_ONLY',
  'POOL_NOT_INITIALIZED',
  'POOL_ALREADY_INITIALIZED_BEFORE_OBSERVATION',
]);
export type SnapshotFailure = z.infer<typeof SnapshotFailureSchema>;

export type SnapshotResult =
  | { captured: true; snapshot: InitialReserveSnapshot }
  | { captured: false; failure: SnapshotFailure; message: string };

/**
 * Capture the initial reserve snapshot for a pool that has reached
 * LP_INITIALIZED.
 *
 * Pure — it reads only the pool it is given. It performs no I/O and will not
 * go looking for a historical value it was not handed.
 *
 * Refuses to produce a snapshot when:
 *
 *  - the pool is not observed initialized (nothing to baseline yet);
 *  - liquidity was estimated rather than read;
 *  - liquidity was unavailable;
 *  - the pool was already initialized before we first observed it, in which
 *    case `witnessedInitialization` is false and there is no initial state to
 *    record. Per the plan's §3 rule, this is reported as unavailable rather
 *    than reconstructed from a later reading.
 */
export function captureInitialReserveSnapshot(args: {
  pool: NormalizedPool;
  /**
   * Whether this process actually witnessed the pool transition into an
   * initialized state, as opposed to finding it already live.
   */
  witnessedInitialization: boolean;
}): SnapshotResult {
  const { pool, witnessedInitialization } = args;

  if (pool.initialization !== 'INITIALIZED') {
    return {
      captured: false,
      failure: 'POOL_NOT_INITIALIZED',
      message: `Pool initialization is ${pool.initialization}; there is no initial state to capture yet.`,
    };
  }

  if (!witnessedInitialization) {
    return {
      captured: false,
      failure: 'POOL_ALREADY_INITIALIZED_BEFORE_OBSERVATION',
      message:
        'The pool was already initialized when first observed. No initial reserve state exists for this process to capture, and reconstructing one from a later reading is not permitted.',
    };
  }

  if (pool.liquidity.provenance === 'ESTIMATED') {
    return {
      captured: false,
      failure: 'RESERVES_ESTIMATED_ONLY',
      message:
        'Liquidity is ESTIMATED. A baseline built from an estimate would make every later comparison unreliable.',
    };
  }

  if (!isObservedOnChain(pool.liquidity)) {
    return {
      captured: false,
      failure: 'RESERVES_NOT_OBSERVED',
      message: 'Liquidity was not observed on chain, so no baseline can be recorded.',
    };
  }

  return {
    captured: true,
    snapshot: {
      poolAddress: pool.poolAddress,
      tokenMint: pool.tokenMint,
      quoteMint: pool.quoteMint,
      dex: pool.dex,
      tokenReserve: pool.tokenReserve,
      quoteReserve: pool.quoteReserve,
      liquidity: pool.liquidity,
      // Guaranteed non-null: isObservedOnChain narrows slot to Slot.
      slot: pool.liquidity.slot,
      txSignature: pool.liquidity.txSignature,
      observedAt: pool.liquidity.observedAt,
      source: pool.source,
    },
  };
}
