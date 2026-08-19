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
 * Observable token/pool lifecycle.
 *
 * Every member corresponds to a condition that can actually be witnessed on
 * chain. States are not aspirational: nothing reaches TRADEABLE because time
 * passed or because a score improved.
 */
export const LifecycleStateSchema = z.enum([
  /** Token exists. No pool account has been seen. */
  'PRE_LP',
  /** A pool account exists. Says nothing about whether it holds reserves. */
  'LP_DETECTED',
  /** The venue reports the pool initialized. Reserves may still be unknown. */
  'LP_INITIALIZED',
  /** Reserves have been observed and are being checked against thresholds. */
  'LIQUIDITY_VALIDATING',
  /** Observed reserves satisfied validation. The only state entry may consider. */
  'TRADEABLE',
  /** Liquidity fell materially from its validated level. */
  'LIQUIDITY_DEGRADED',
  /** Liquidity is effectively gone. */
  'LIQUIDITY_REMOVED',
  /** Terminal. Pool closed or abandoned. */
  'CLOSED',
]);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

/**
 * Why a transition happened.
 *
 * Codes rather than free text so downstream consumers can branch on them and
 * the dashboard can render an explanation without parsing prose.
 */
export const LifecycleReasonSchema = z.enum([
  'TOKEN_DETECTED',
  'POOL_ACCOUNT_DETECTED',
  'POOL_REPORTED_INITIALIZED',
  'RESERVES_OBSERVED',
  'LIQUIDITY_VALIDATED',
  'LIQUIDITY_BELOW_THRESHOLD',
  'LIQUIDITY_DROP_OBSERVED',
  'LIQUIDITY_REMOVED_OBSERVED',
  'POOL_CLOSED_OBSERVED',
  /** An observation was attempted and produced no usable value. */
  'OBSERVATION_UNAVAILABLE',
]);
export type LifecycleReason = z.infer<typeof LifecycleReasonSchema>;

/** One transition, with the evidence that justified it. */
export interface LifecycleRecord {
  state: LifecycleState;
  reason: LifecycleReason;
  /** Slot the justifying observation was read at, when it was an observation. */
  slot: Slot | null;
  txSignature: TransactionSignature | null;
  observedAt: Timestamp;
  /** Human-readable detail for the audit trail. */
  detail: string;
}

export const LifecycleRecordSchema = z
  .object({
    state: LifecycleStateSchema,
    reason: LifecycleReasonSchema,
    slot: SlotSchema.nullable(),
    txSignature: TransactionSignatureSchema.nullable(),
    observedAt: TimestampSchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

/**
 * Permitted transitions.
 *
 * The safety-critical property encoded here: **LP_DETECTED cannot reach
 * TRADEABLE.** A pool account existing is not evidence that it holds usable
 * liquidity, and the plan's §1 calls this out explicitly. The only path to
 * TRADEABLE runs through LP_INITIALIZED and LIQUIDITY_VALIDATING, i.e. through
 * an actual reserve observation.
 *
 * Forward progress is otherwise monotonic. The exceptions are deliberate:
 *
 *  - Degradation states may recover to TRADEABLE, because liquidity genuinely
 *    can be added back and refusing to recognise that would strand a pool in a
 *    degraded state forever.
 *  - LIQUIDITY_REMOVED may not return to TRADEABLE directly. Recovery from an
 *    emptied pool must be re-validated through LIQUIDITY_VALIDATING, since the
 *    conditions that made it tradeable were destroyed.
 *  - CLOSED is terminal from everywhere and returns to nothing.
 */
const TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  PRE_LP: ['LP_DETECTED', 'CLOSED'],
  LP_DETECTED: ['LP_INITIALIZED', 'LIQUIDITY_REMOVED', 'CLOSED'],
  LP_INITIALIZED: ['LIQUIDITY_VALIDATING', 'LIQUIDITY_REMOVED', 'CLOSED'],
  LIQUIDITY_VALIDATING: [
    'TRADEABLE',
    'LIQUIDITY_DEGRADED',
    'LIQUIDITY_REMOVED',
    'CLOSED',
  ],
  TRADEABLE: ['LIQUIDITY_DEGRADED', 'LIQUIDITY_REMOVED', 'CLOSED'],
  LIQUIDITY_DEGRADED: ['TRADEABLE', 'LIQUIDITY_REMOVED', 'CLOSED'],
  LIQUIDITY_REMOVED: ['LIQUIDITY_VALIDATING', 'CLOSED'],
  CLOSED: [],
};

export function canTransition(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(
  from: LifecycleState,
): readonly LifecycleState[] {
  return TRANSITIONS[from];
}

/** States in which an entry may be considered. Exactly one, on purpose. */
export function isTradeableState(state: LifecycleState): boolean {
  return state === 'TRADEABLE';
}

/** Terminal states admit no further transitions. */
export function isTerminalState(state: LifecycleState): boolean {
  return TRANSITIONS[state].length === 0;
}
