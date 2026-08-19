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
import { ObservedNumberSchema, type Observed } from './provenance.js';

/**
 * Liquidity venue.
 *
 * Only venues the repository can actually decode today. `RaydiumPoolVerifier`
 * covers Raydium AMM-v4 and CPMM; `readBondingCurve` covers the pump.fun
 * bonding curve. Adding a member here without an adapter that decodes it would
 * let callers believe a venue is supported when it is not.
 */
export const DexSchema = z.enum(['raydium', 'pumpfun']);
export type Dex = z.infer<typeof DexSchema>;

/**
 * Venue-specific pool shape.
 *
 * `bonding-curve` is deliberately in the same union as the Raydium pool types:
 * a pump.fun bonding curve is this token's only liquidity until it graduates,
 * and treating it as "not a pool" is what leads to a token being classified as
 * having no liquidity when it demonstrably has reserves.
 */
export const PoolTypeSchema = z.enum(['amm-v4', 'cpmm', 'bonding-curve']);
export type PoolType = z.infer<typeof PoolTypeSchema>;

/**
 * Whether the venue considers this pool initialized.
 *
 * `UNKNOWN` is a first-class member and the correct value whenever the flag
 * could not be read. `readBondingCurve` already models this: its `complete`
 * field is `undefined` rather than `false` when the account data was too short
 * to contain the byte. Collapsing that into a boolean would tell the caller a
 * token is still on the curve when we simply could not tell.
 */
export const PoolInitializationSchema = z.enum([
  'NOT_INITIALIZED',
  'INITIALIZED',
  'UNKNOWN',
]);
export type PoolInitialization = z.infer<typeof PoolInitializationSchema>;

/**
 * Venue-agnostic pool representation.
 *
 * Every quantity is an `Observed<number>` so a consumer can always tell a
 * reading from an estimate from an absence. Identity fields (addresses, mints)
 * are plain values: they either came from a decoded account or the adapter
 * could not produce a pool at all.
 *
 * Units are stated per field and are not interchangeable. `quoteReserve` is in
 * whole quote tokens (SOL for every venue currently supported), not lamports.
 */
export interface NormalizedPool {
  poolAddress: PublicKey;
  tokenMint: PublicKey;
  quoteMint: PublicKey;
  dex: Dex;
  poolType: PoolType;

  /** Vault holding the token side. Null for venues without discrete vaults. */
  baseVault: PublicKey | null;
  /** Vault holding the quote side. Null for venues without discrete vaults. */
  quoteVault: PublicKey | null;
  /** LP mint, where the venue has one. A bonding curve does not. */
  lpMint: PublicKey | null;

  /** Token-side reserve, in whole tokens. */
  tokenReserve: Observed<number>;
  /** Quote-side reserve, in whole quote tokens (SOL). */
  quoteReserve: Observed<number>;
  /**
   * Total liquidity expressed in quote terms (SOL).
   *
   * Deliberately not a USD figure: no SOL/USD price feed exists in this
   * repository, and estimating one would violate the unknown-data policy.
   */
  liquidity: Observed<number>;

  initialization: PoolInitialization;

  /** Slot the pool account was first seen at, if known. */
  detectedSlot: Slot | null;
  /** Slot the pool was observed initialized at, if that was witnessed. */
  initializedSlot: Slot | null;
  /** Signature that created or initialized the pool, if known. */
  txSignature: TransactionSignature | null;

  observedAt: Timestamp;
  /** Concrete origin of this normalization, e.g. 'raydium-pool-verifier'. */
  source: string;

  /**
   * LP lock or burn status.
   *
   * `null` means unverified, which is the only honest default. Per the plan's
   * §5 rule, an LP is never reported as locked without direct evidence, and no
   * adapter currently produces that evidence.
   */
  lpLockOrBurnVerified: boolean | null;
}

export const NormalizedPoolSchema = z
  .object({
    poolAddress: PublicKeySchema,
    tokenMint: PublicKeySchema,
    quoteMint: PublicKeySchema,
    dex: DexSchema,
    poolType: PoolTypeSchema,
    baseVault: PublicKeySchema.nullable(),
    quoteVault: PublicKeySchema.nullable(),
    lpMint: PublicKeySchema.nullable(),
    tokenReserve: ObservedNumberSchema,
    quoteReserve: ObservedNumberSchema,
    liquidity: ObservedNumberSchema,
    initialization: PoolInitializationSchema,
    detectedSlot: SlotSchema.nullable(),
    initializedSlot: SlotSchema.nullable(),
    txSignature: TransactionSignatureSchema.nullable(),
    observedAt: TimestampSchema,
    source: z.string().min(1).max(200),
    lpLockOrBurnVerified: z.boolean().nullable(),
  })
  .strict();
