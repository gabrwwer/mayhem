import type { Slot, Timestamp, TransactionSignature } from '@mayhem/core-types';
import type { Dex, NormalizedPool } from '../pool.js';

/**
 * Evidence accompanying a venue observation.
 *
 * Passed in rather than read inside an adapter so adapters stay pure and
 * deterministic — no clock reads, no ambient slot lookups. That is what makes
 * them testable from fixtures with no RPC.
 */
export interface AdapterContext {
  /** Slot the underlying account data was read at, if known. */
  slot: Slot | null;
  txSignature: TransactionSignature | null;
  observedAt: Timestamp;
  /**
   * Whether this process witnessed the pool becoming initialized, as opposed
   * to finding it already live. Threaded through to Phase 3, which refuses to
   * fabricate a baseline for a pool it did not see start.
   */
  witnessedInitialization: boolean;
}

export type AdapterResult =
  | { ok: true; pool: NormalizedPool }
  | { ok: false; reason: string };

/**
 * Normalizes one venue's decoded output into `NormalizedPool`.
 *
 * Adapters translate; they do not fetch. Decoding already lives in
 * `RaydiumPoolVerifier` and `readBondingCurve`, and duplicating it here would
 * create a second implementation to keep in sync with the chain.
 */
export interface PoolAdapter<TRaw> {
  readonly dex: Dex;
  /**
   * Convert a venue-specific decoded observation into a normalized pool.
   * Returns a reason rather than throwing when the input cannot be normalized,
   * since an undecodable pool is an expected outcome, not an exception.
   */
  normalize(raw: TRaw, context: AdapterContext): AdapterResult;
}
