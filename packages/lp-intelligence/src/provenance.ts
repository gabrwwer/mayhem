import { z } from 'zod';
import {
  SlotSchema,
  TimestampSchema,
  TransactionSignatureSchema,
  type Slot,
  type Timestamp,
  type TransactionSignature,
} from '@mayhem/core-types';

/**
 * Where a measurement came from.
 *
 * This distinction is the whole point of the module. A liquidity figure read
 * from a vault account and a liquidity figure inferred from a later swap are
 * not interchangeable, and an operator deciding whether to hold a position
 * needs to know which one they are looking at.
 *
 *  - OBSERVED_ONCHAIN: read directly from chain state at a known slot.
 *  - ESTIMATED:        derived or inferred. Never presented as observed.
 *  - UNAVAILABLE:      not known. Carries no value at all.
 */
export const ProvenanceSchema = z.enum([
  'OBSERVED_ONCHAIN',
  'ESTIMATED',
  'UNAVAILABLE',
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * A measurement together with its evidence.
 *
 * Invariants, enforced by `ObservedSchema` and by the constructors below:
 *
 *  1. `provenance === 'UNAVAILABLE'` implies `value === null`.
 *  2. `value === null` implies `provenance === 'UNAVAILABLE'`.
 *     There is no such thing as an observed null — if we did not observe it,
 *     the provenance says so.
 *  3. `provenance === 'OBSERVED_ONCHAIN'` requires a `slot`. A reading with no
 *     slot cannot be placed in time, cannot be ordered against other readings,
 *     and cannot be reconciled after a reorg, so it does not qualify as an
 *     on-chain observation.
 *
 * `txSignature` is optional even for observations: an account read via
 * `getAccountInfo` has a slot but no originating signature. It is recorded
 * whenever the observation came from a transaction.
 */
export interface Observed<T> {
  value: T | null;
  provenance: Provenance;
  slot: Slot | null;
  txSignature: TransactionSignature | null;
  /** Wall-clock time the observation was taken, ms since epoch. */
  observedAt: Timestamp;
  /** Concrete origin, e.g. 'raydium-amm-v4:quote-vault'. Never a bare 'rpc'. */
  source: string;
}

/**
 * Runtime schema for `Observed<number>`.
 *
 * Written as a factory so the same invariants apply to any payload type
 * without restating the refinements.
 */
export function observedSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      value: value.nullable(),
      provenance: ProvenanceSchema,
      slot: SlotSchema.nullable(),
      txSignature: TransactionSignatureSchema.nullable(),
      observedAt: TimestampSchema,
      source: z.string().min(1).max(200),
    })
    .strict()
    .refine((o) => (o.provenance === 'UNAVAILABLE') === (o.value === null), {
      message:
        'value must be null if and only if provenance is UNAVAILABLE — there is no observed null',
      path: ['value'],
    })
    .refine((o) => o.provenance !== 'OBSERVED_ONCHAIN' || o.slot !== null, {
      message:
        'an OBSERVED_ONCHAIN measurement must carry the slot it was read at',
      path: ['slot'],
    });
}

export const ObservedNumberSchema = observedSchema(z.number().finite());

/** Convenience alias — most LP measurements are numeric. */
export type ObservedNumber = Observed<number>;

export interface ObservationEvidence {
  slot: Slot;
  txSignature?: TransactionSignature | null;
  observedAt: Timestamp;
  source: string;
}

/**
 * Record a value actually read from chain state.
 *
 * Requires a slot by construction — the type will not let a caller claim an
 * on-chain observation without saying when it was read.
 */
export function observed<T>(value: T, evidence: ObservationEvidence): Observed<T> {
  return {
    value,
    provenance: 'OBSERVED_ONCHAIN',
    slot: evidence.slot,
    txSignature: evidence.txSignature ?? null,
    observedAt: evidence.observedAt,
    source: evidence.source,
  };
}

/**
 * Record a derived or inferred value.
 *
 * Kept deliberately awkward relative to `observed()`: it takes no slot, so an
 * estimate can never be mistaken for a reading at a point in the chain.
 */
export function estimated<T>(
  value: T,
  evidence: { observedAt: Timestamp; source: string },
): Observed<T> {
  return {
    value,
    provenance: 'ESTIMATED',
    slot: null,
    txSignature: null,
    observedAt: evidence.observedAt,
    source: evidence.source,
  };
}

/**
 * Record that a measurement is not known.
 *
 * This is the correct return for every "we could not read it" path. Returning
 * zero, or omitting the field, both read downstream as information we do not
 * have.
 */
export function unavailable<T>(evidence: {
  observedAt: Timestamp;
  source: string;
}): Observed<T> {
  return {
    value: null,
    provenance: 'UNAVAILABLE',
    slot: null,
    txSignature: null,
    observedAt: evidence.observedAt,
    source: evidence.source,
  };
}

/** True only for a real on-chain reading. Estimates return false. */
export function isObservedOnChain<T>(
  o: Observed<T>,
): o is Observed<T> & { value: T; slot: Slot } {
  return o.provenance === 'OBSERVED_ONCHAIN' && o.value !== null;
}

/** True when any value is present, observed or estimated. */
export function hasValue<T>(o: Observed<T>): o is Observed<T> & { value: T } {
  return o.value !== null;
}

/**
 * Read a value only if it was genuinely observed on chain.
 *
 * Use this at every decision point that must not act on an estimate. Callers
 * that are content with an estimate should read `.value` explicitly, which
 * makes the weaker requirement visible at the call site.
 */
export function observedValueOrNull<T>(o: Observed<T>): T | null {
  return isObservedOnChain(o) ? o.value : null;
}

/**
 * Map an observation's payload while preserving its evidence.
 *
 * An UNAVAILABLE observation stays UNAVAILABLE — `fn` is never invoked on a
 * null, so a mapper cannot accidentally manufacture a value from nothing.
 */
export function mapObserved<T, U>(
  o: Observed<T>,
  fn: (value: T) => U,
): Observed<U> {
  if (o.value === null) {
    return {
      value: null,
      provenance: o.provenance,
      slot: o.slot,
      txSignature: o.txSignature,
      observedAt: o.observedAt,
      source: o.source,
    };
  }

  return { ...o, value: fn(o.value) };
}
