import type { Slot, Timestamp, TransactionSignature } from '@mayhem/core-types';
import {
  canTransition,
  isTerminalState,
  type LifecycleReason,
  type LifecycleRecord,
  type LifecycleState,
} from './lifecycle.js';
import { isObservedOnChain, type Observed } from './provenance.js';

export interface TransitionInput {
  to: LifecycleState;
  reason: LifecycleReason;
  detail: string;
  observedAt: Timestamp;
  slot?: Slot | null;
  txSignature?: TransactionSignature | null;
}

export type TransitionOutcome =
  | { applied: true; record: LifecycleRecord }
  | { applied: false; rejection: TransitionRejection };

export interface TransitionRejection {
  code:
    | 'ILLEGAL_TRANSITION'
    | 'TERMINAL_STATE'
    | 'STALE_OBSERVATION'
    | 'INSUFFICIENT_EVIDENCE';
  from: LifecycleState;
  to: LifecycleState;
  message: string;
}

/**
 * Deterministic lifecycle state machine.
 *
 * Pure: no I/O, no clock reads, no randomness. Every input that affects the
 * outcome is passed in, which is what makes the transition rules testable
 * without a chain.
 *
 * Three properties it exists to guarantee:
 *
 *  1. A pool account being detected never yields TRADEABLE. The only route
 *     runs through an actual reserve observation.
 *  2. An unavailable observation is never positive evidence. `validate()`
 *     rejects rather than advancing when reserves could not be read.
 *  3. Out-of-order observations do not rewrite history. A transition justified
 *     by an older slot than the one already recorded is refused, so a late
 *     RPC response cannot resurrect a stale reading.
 */
export class LifecycleStateMachine {
  private current: LifecycleState;
  private readonly records: LifecycleRecord[] = [];
  /** Highest slot that has justified a transition so far. */
  private highWaterSlot: Slot | null = null;

  constructor(initial: LifecycleRecord) {
    this.current = initial.state;
    this.records.push(initial);
    this.highWaterSlot = initial.slot;
  }

  /** Create a machine for a token that has been detected but has no pool. */
  static preLp(args: {
    observedAt: Timestamp;
    detail?: string;
    slot?: Slot | null;
    txSignature?: TransactionSignature | null;
  }): LifecycleStateMachine {
    return new LifecycleStateMachine({
      state: 'PRE_LP',
      reason: 'TOKEN_DETECTED',
      slot: args.slot ?? null,
      txSignature: args.txSignature ?? null,
      observedAt: args.observedAt,
      detail: args.detail ?? 'Token detected; no pool account observed yet.',
    });
  }

  get state(): LifecycleState {
    return this.current;
  }

  /** Full ordered transition history. Copied so callers cannot mutate it. */
  get history(): readonly LifecycleRecord[] {
    return [...this.records];
  }

  get latest(): LifecycleRecord {
    // Non-empty by construction: the constructor always pushes one record.
    const last = this.records[this.records.length - 1];
    if (last === undefined) {
      throw new Error('LifecycleStateMachine invariant violated: empty history');
    }
    return last;
  }

  /**
   * Attempt a transition.
   *
   * Returns an outcome rather than throwing. A refused transition is a normal,
   * expected event — a duplicate websocket message or a late poll response
   * will produce them routinely — and forcing callers into try/catch for
   * ordinary control flow tends to end in a bare catch that swallows the
   * reason.
   */
  apply(input: TransitionInput): TransitionOutcome {
    const from = this.current;
    const slot = input.slot ?? null;

    if (isTerminalState(from)) {
      return {
        applied: false,
        rejection: {
          code: 'TERMINAL_STATE',
          from,
          to: input.to,
          message: `${from} is terminal; no further transitions are possible.`,
        },
      };
    }

    if (!canTransition(from, input.to)) {
      return {
        applied: false,
        rejection: {
          code: 'ILLEGAL_TRANSITION',
          from,
          to: input.to,
          message: `${from} -> ${input.to} is not a permitted transition.`,
        },
      };
    }

    // Reject observations older than what we have already acted on. Without
    // this, a slow RPC response carrying pre-drain reserves could move a pool
    // back to TRADEABLE after a drain had already been recorded.
    if (slot !== null && this.highWaterSlot !== null && slot < this.highWaterSlot) {
      return {
        applied: false,
        rejection: {
          code: 'STALE_OBSERVATION',
          from,
          to: input.to,
          message: `Observation at slot ${slot} is older than the recorded slot ${this.highWaterSlot}.`,
        },
      };
    }

    const record: LifecycleRecord = {
      state: input.to,
      reason: input.reason,
      slot,
      txSignature: input.txSignature ?? null,
      observedAt: input.observedAt,
      detail: input.detail,
    };

    this.records.push(record);
    this.current = input.to;
    if (slot !== null) {
      this.highWaterSlot = slot;
    }

    return { applied: true, record };
  }

  /**
   * Advance to TRADEABLE only on the strength of an on-chain reserve reading
   * that meets the supplied floor.
   *
   * This is the single gate that decides tradeability, and it is deliberately
   * narrow:
   *
   *  - An ESTIMATED liquidity value is refused. An estimate is not evidence
   *    that a pool can absorb an order.
   *  - An UNAVAILABLE reading is refused, and produces a
   *    LIQUIDITY_VALIDATING -> LIQUIDITY_DEGRADED style rejection rather than
   *    silently leaving the caller to interpret a null.
   *  - `minLiquidity` of 0 still requires a reading. "No configured floor"
   *    means any observed depth passes, not that an unread pool passes.
   */
  validate(args: {
    liquidity: Observed<number>;
    minLiquidity: number;
    observedAt: Timestamp;
  }): TransitionOutcome {
    const { liquidity, minLiquidity, observedAt } = args;

    if (!isObservedOnChain(liquidity)) {
      return {
        applied: false,
        rejection: {
          code: 'INSUFFICIENT_EVIDENCE',
          from: this.current,
          to: 'TRADEABLE',
          message:
            liquidity.provenance === 'ESTIMATED'
              ? 'Liquidity is ESTIMATED; only an on-chain observation can validate tradeability.'
              : 'Liquidity is UNAVAILABLE; an unread pool is not a validated pool.',
        },
      };
    }

    if (liquidity.value < minLiquidity) {
      return this.apply({
        to: 'LIQUIDITY_DEGRADED',
        reason: 'LIQUIDITY_BELOW_THRESHOLD',
        detail: `Observed liquidity ${liquidity.value} is below the required ${minLiquidity}.`,
        observedAt,
        slot: liquidity.slot,
        txSignature: liquidity.txSignature,
      });
    }

    return this.apply({
      to: 'TRADEABLE',
      reason: 'LIQUIDITY_VALIDATED',
      detail: `Observed liquidity ${liquidity.value} meets the required ${minLiquidity}.`,
      observedAt,
      slot: liquidity.slot,
      txSignature: liquidity.txSignature,
    });
  }
}
