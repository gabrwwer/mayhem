import { z } from 'zod';
import { TimestampSchema, type Timestamp } from '@mayhem/core-types';
import { ObservedNumberSchema, type Observed } from './provenance.js';

/**
 * LP health.
 *
 * `UNKNOWN` is not a failure mode to be avoided — it is the correct answer
 * whenever liquidity could not be read, and it is deliberately distinct from
 * `CRITICAL`. An operator must be able to tell "this pool is being drained"
 * from "we cannot see this pool".
 */
export const LpHealthStatusSchema = z.enum([
  'HEALTHY',
  'STABLE',
  'WATCH',
  'DEGRADED',
  'CRITICAL',
  'UNKNOWN',
]);
export type LpHealthStatus = z.infer<typeof LpHealthStatusSchema>;

export const LpHealthReasonSchema = z.enum([
  'NO_OBSERVATION',
  'NO_BASELINE',
  'LIQUIDITY_STABLE',
  'LIQUIDITY_GREW',
  'LIQUIDITY_MINOR_DECLINE',
  'LIQUIDITY_MATERIAL_DECLINE',
  'LIQUIDITY_SEVERE_DECLINE',
  'LIQUIDITY_EFFECTIVELY_REMOVED',
]);
export type LpHealthReason = z.infer<typeof LpHealthReasonSchema>;

export interface LpHealth {
  status: LpHealthStatus;
  currentLiquidity: Observed<number>;
  /** Baseline to compare against, normally the initial reserve snapshot. */
  initialLiquidity: Observed<number> | null;
  /** Percentage change from baseline. Null unless both were observed. */
  liquidityChangePct: number | null;
  degraded: boolean;
  removed: boolean;
  reasons: LpHealthReason[];
  assessedAt: Timestamp;
}

export const LpHealthSchema = z
  .object({
    status: LpHealthStatusSchema,
    currentLiquidity: ObservedNumberSchema,
    initialLiquidity: ObservedNumberSchema.nullable(),
    liquidityChangePct: z.number().finite().nullable(),
    degraded: z.boolean(),
    removed: z.boolean(),
    reasons: z.array(LpHealthReasonSchema),
    assessedAt: TimestampSchema,
  })
  .strict();

/**
 * Thresholds, expressed as percentage declines from baseline.
 *
 * Defaults are intentionally not read from configuration in this phase — the
 * plan defers config wiring to Phase 9. Callers pass thresholds explicitly so
 * this function stays pure and the values in force are visible at the call
 * site rather than hidden in a module-level default.
 */
export interface LpHealthThresholds {
  /** Below this decline the pool is merely being watched, e.g. 10. */
  watchDeclinePct: number;
  /** At or beyond this decline the pool is degraded, e.g. 25. */
  degradedDeclinePct: number;
  /** At or beyond this decline the pool is critical, e.g. 50. */
  criticalDeclinePct: number;
  /**
   * At or below this absolute liquidity the pool counts as removed,
   * regardless of percentage. Guards the case where a pool started tiny.
   */
  removedAtOrBelow: number;
}

/**
 * Classify LP health from observations alone.
 *
 * Pure and total: every input combination produces a status, and none of them
 * produce a fabricated number.
 *
 * The ordering matters. An unreadable current liquidity yields UNKNOWN before
 * any threshold is consulted — a missing reading must never be compared
 * against a floor as though it were zero, because that would report a healthy
 * pool as fully drained on a single failed RPC call.
 */
export function assessLpHealth(args: {
  currentLiquidity: Observed<number>;
  initialLiquidity: Observed<number> | null;
  thresholds: LpHealthThresholds;
  assessedAt: Timestamp;
}): LpHealth {
  const { currentLiquidity, initialLiquidity, thresholds, assessedAt } = args;

  const base = {
    currentLiquidity,
    initialLiquidity,
    assessedAt,
  };

  // No usable current reading. Not a judgement about the pool.
  if (
    currentLiquidity.provenance !== 'OBSERVED_ONCHAIN' ||
    currentLiquidity.value === null
  ) {
    return {
      ...base,
      status: 'UNKNOWN',
      liquidityChangePct: null,
      degraded: false,
      removed: false,
      reasons: ['NO_OBSERVATION'],
    };
  }

  const current = currentLiquidity.value;

  // An effectively empty pool is removed whether or not a baseline exists.
  if (current <= thresholds.removedAtOrBelow) {
    return {
      ...base,
      status: 'CRITICAL',
      liquidityChangePct: null,
      degraded: true,
      removed: true,
      reasons: ['LIQUIDITY_EFFECTIVELY_REMOVED'],
    };
  }

  // Observed liquidity but nothing to compare against. Reporting HEALTHY here
  // would assert stability we have not witnessed.
  if (
    initialLiquidity === null ||
    initialLiquidity.provenance !== 'OBSERVED_ONCHAIN' ||
    initialLiquidity.value === null ||
    initialLiquidity.value <= 0
  ) {
    return {
      ...base,
      status: 'UNKNOWN',
      liquidityChangePct: null,
      degraded: false,
      removed: false,
      reasons: ['NO_BASELINE'],
    };
  }

  const initial = initialLiquidity.value;
  const changePct = ((current - initial) / initial) * 100;
  const declinePct = -changePct;

  if (changePct > 0) {
    return {
      ...base,
      status: 'HEALTHY',
      liquidityChangePct: changePct,
      degraded: false,
      removed: false,
      reasons: ['LIQUIDITY_GREW'],
    };
  }

  if (declinePct >= thresholds.criticalDeclinePct) {
    return {
      ...base,
      status: 'CRITICAL',
      liquidityChangePct: changePct,
      degraded: true,
      removed: false,
      reasons: ['LIQUIDITY_SEVERE_DECLINE'],
    };
  }

  if (declinePct >= thresholds.degradedDeclinePct) {
    return {
      ...base,
      status: 'DEGRADED',
      liquidityChangePct: changePct,
      degraded: true,
      removed: false,
      reasons: ['LIQUIDITY_MATERIAL_DECLINE'],
    };
  }

  if (declinePct >= thresholds.watchDeclinePct) {
    return {
      ...base,
      status: 'WATCH',
      liquidityChangePct: changePct,
      degraded: false,
      removed: false,
      reasons: ['LIQUIDITY_MINOR_DECLINE'],
    };
  }

  return {
    ...base,
    status: 'STABLE',
    liquidityChangePct: changePct,
    degraded: false,
    removed: false,
    reasons: ['LIQUIDITY_STABLE'],
  };
}
