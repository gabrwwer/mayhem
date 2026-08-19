import { z } from 'zod';
import { TimestampSchema, type Timestamp } from '@mayhem/core-types';
import { LifecycleStateSchema, type LifecycleState } from './lifecycle.js';
import { LpHealthStatusSchema, type LpHealthStatus } from './health.js';

/**
 * Why an entry is not permitted.
 *
 * Codes, not prose, so the execution layer can branch and the dashboard can
 * explain a block without string matching.
 */
export const EligibilityReasonSchema = z.enum([
  'POOL_NOT_INITIALIZED',
  'POOL_NOT_TRADEABLE',
  'LIQUIDITY_TOO_LOW',
  'LIQUIDITY_UNSTABLE',
  'LIQUIDITY_REMOVED',
  'INITIAL_SNAPSHOT_MISSING',
  'LP_STATE_UNKNOWN',
  'TOKEN_AUTHORITY_RISK',
  'HIGH_PRICE_IMPACT',
  'RISK_LIMIT_REACHED',
]);
export type EligibilityReason = z.infer<typeof EligibilityReasonSchema>;

const REASON_TEXT: Readonly<Record<EligibilityReason, string>> = {
  POOL_NOT_INITIALIZED: 'The pool has not been observed in an initialized state.',
  POOL_NOT_TRADEABLE:
    'The pool lifecycle has not reached TRADEABLE. A detected or initialized pool is not evidence of usable liquidity.',
  LIQUIDITY_TOO_LOW: 'Observed liquidity is below the configured minimum.',
  LIQUIDITY_UNSTABLE: 'Liquidity has declined materially from its baseline.',
  LIQUIDITY_REMOVED: 'Liquidity has been effectively removed from the pool.',
  INITIAL_SNAPSHOT_MISSING:
    'No initial reserve observation exists for this pool, so liquidity cannot be compared against a baseline.',
  LP_STATE_UNKNOWN:
    'Liquidity state could not be observed. Unknown is not treated as safe.',
  TOKEN_AUTHORITY_RISK:
    'Mint or freeze authority remains active on this token.',
  HIGH_PRICE_IMPACT: 'Estimated price impact exceeds the configured maximum.',
  RISK_LIMIT_REACHED: 'A portfolio or circuit-breaker risk limit is in force.',
};

/** Human-readable explanation for a reason code. */
export function explainReason(reason: EligibilityReason): string {
  return REASON_TEXT[reason];
}

/**
 * The result of an entry-eligibility evaluation.
 *
 * NOT wired to the execution engine in this phase — that is Phase 6, and doing
 * it here would change what the bot is allowed to trade. This type exists so
 * Phase 6 has a settled contract to implement against.
 *
 * The `eligible === (reasons.length === 0)` invariant is enforced by the
 * schema. It mirrors `RiskVerdictSchema`'s `approved`/`breaches` refinement in
 * @mayhem/core-types: an approval with unexplained blockers, or a block with
 * no stated reason, is a bug rather than a state to be interpreted.
 */
export interface EntryEligibility {
  eligible: boolean;
  reasons: EligibilityReason[];
  /** One explanation per reason, in the same order. */
  explanations: string[];
  lifecycleState: LifecycleState;
  lpHealth: LpHealthStatus;
  evaluatedAt: Timestamp;
}

export const EntryEligibilitySchema = z
  .object({
    eligible: z.boolean(),
    reasons: z.array(EligibilityReasonSchema),
    explanations: z.array(z.string().min(1).max(500)),
    lifecycleState: LifecycleStateSchema,
    lpHealth: LpHealthStatusSchema,
    evaluatedAt: TimestampSchema,
  })
  .strict()
  .refine((e) => e.eligible === (e.reasons.length === 0), {
    message: 'eligible must be true if and only if there are no reasons',
    path: ['eligible'],
  })
  .refine((e) => e.reasons.length === e.explanations.length, {
    message: 'every reason must carry exactly one explanation',
    path: ['explanations'],
  });

/**
 * Build an eligibility result from lifecycle and health alone.
 *
 * Deliberately conservative and deliberately incomplete: it evaluates only the
 * signals this package owns. Authority risk, price impact and portfolio limits
 * are the risk engine's concerns and are passed in as already-decided reason
 * codes rather than re-derived here, so there is exactly one implementation of
 * each check in the codebase.
 */
export function evaluateEntryEligibility(args: {
  lifecycleState: LifecycleState;
  lpHealth: LpHealthStatus;
  /** True when an initial reserve observation exists for the pool. */
  hasInitialSnapshot: boolean;
  /** Whether a missing initial snapshot should block. Phase 9 wires config. */
  requireInitialSnapshot: boolean;
  /** Reason codes contributed by other subsystems, e.g. the risk engine. */
  externalReasons?: readonly EligibilityReason[];
  evaluatedAt: Timestamp;
}): EntryEligibility {
  const reasons: EligibilityReason[] = [];

  // Lifecycle is the primary gate. Anything short of TRADEABLE blocks, which
  // is what stops a merely-detected pool from being treated as tradeable.
  if (args.lifecycleState !== 'TRADEABLE') {
    reasons.push(
      args.lifecycleState === 'PRE_LP' || args.lifecycleState === 'LP_DETECTED'
        ? 'POOL_NOT_INITIALIZED'
        : args.lifecycleState === 'LIQUIDITY_REMOVED'
          ? 'LIQUIDITY_REMOVED'
          : 'POOL_NOT_TRADEABLE',
    );
  }

  switch (args.lpHealth) {
    case 'CRITICAL':
      reasons.push('LIQUIDITY_REMOVED');
      break;
    case 'DEGRADED':
      reasons.push('LIQUIDITY_UNSTABLE');
      break;
    case 'UNKNOWN':
      // Unknown is never positive evidence.
      reasons.push('LP_STATE_UNKNOWN');
      break;
    case 'HEALTHY':
    case 'STABLE':
    case 'WATCH':
      break;
  }

  if (args.requireInitialSnapshot && !args.hasInitialSnapshot) {
    reasons.push('INITIAL_SNAPSHOT_MISSING');
  }

  for (const reason of args.externalReasons ?? []) {
    reasons.push(reason);
  }

  // De-duplicate while preserving order: lifecycle and health can both yield
  // LIQUIDITY_REMOVED, and a repeated code reads as two separate problems.
  const unique = [...new Set(reasons)];

  return {
    eligible: unique.length === 0,
    reasons: unique,
    explanations: unique.map(explainReason),
    lifecycleState: args.lifecycleState,
    lpHealth: args.lpHealth,
    evaluatedAt: args.evaluatedAt,
  };
}
