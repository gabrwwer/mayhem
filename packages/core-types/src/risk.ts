
import { z } from 'zod';
import {
  BasisPointsSchema,
  CorrelationIdSchema,
  RawAmountSchema,
  StrategyIdSchema,
  TimestampSchema,
} from './primitives.js';

export const RiskRuleSchema = z.enum([
  'max_position_size',
  'max_notional',
  'max_strategy_exposure',
  'max_global_exposure',
  'max_concentration',
  'max_slippage',
  'daily_loss_limit',
  'max_drawdown',
  'circuit_breaker_consecutive_losses',
  'circuit_breaker_latency',
  'stale_market_data',
  'market_data_unavailable',
  'intent_expired',
  'kill_switch_engaged',
  'agent_quarantined',
  'manipulation_suspected',
  'liquidity_insufficient',
  'token_not_sellable',
]);
export type RiskRule = z.infer<typeof RiskRuleSchema>;

export const RiskBreachSchema = z
  .object({
    rule: RiskRuleSchema,
    /** Observed value, rendered for the audit trail. */
    observed: z.string().max(200),
    /** Configured limit the observation was compared against. */
    limit: z.string().max(200),
    message: z.string().min(1).max(500),
  })
  .strict();
export type RiskBreach = z.infer<typeof RiskBreachSchema>;

/**
 * Result of the synchronous pre-trade check. Every order must carry an
 * `approved` verdict; absence of a verdict is a rejection, never a pass.
 */
export const RiskVerdictSchema = z
  .object({
    verdictId: z.string().uuid(),
    correlationId: CorrelationIdSchema,
    intentId: z.string().uuid(),
    evaluatedAt: TimestampSchema,
    approved: z.boolean(),
    /** Non-empty whenever `approved` is false. */
    breaches: z.array(RiskBreachSchema),
    /** Size the risk engine permits, which may be below the requested amount. */
    approvedAmountIn: RawAmountSchema.optional(),
    /** Slippage bound the risk engine imposes, which may tighten the intent's. */
    enforcedMaxSlippageBps: BasisPointsSchema.optional(),
    /** Composite 0-100 score; higher is riskier. */
    riskScore: z.number().min(0).max(100),
  })
  .strict()
  .refine((verdict) => verdict.approved === (verdict.breaches.length === 0), {
    message: 'approved must be true if and only if there are no breaches',
    path: ['approved'],
  })
  .refine((verdict) => !verdict.approved || verdict.approvedAmountIn !== undefined, {
    message: 'an approved verdict must specify approvedAmountIn',
    path: ['approvedAmountIn'],
  });
export type RiskVerdict = z.infer<typeof RiskVerdictSchema>;

export const RiskLimitsSchema = z
  .object({
    strategyId: StrategyIdSchema.optional(),
    maxPositionLamports: RawAmountSchema,
    maxNotionalPerOrderLamports: RawAmountSchema,
    maxStrategyExposureLamports: RawAmountSchema,
    maxGlobalExposureLamports: RawAmountSchema,
    maxConcentrationBps: BasisPointsSchema,
    maxSlippageBps: BasisPointsSchema,
    /** Share of pool depth a single order may take. */
    maxLiquidityParticipationBps: BasisPointsSchema,
    /** Manipulation score, 0-100, at or above which the engine refuses to trade. */
    manipulationScoreThreshold: z.number().min(0).max(100),
    dailyLossLimitLamports: RawAmountSchema,
    maxDrawdownBps: BasisPointsSchema,
    maxConsecutiveLosses: z.number().int().positive(),
    /** Market data older than this must cause a rejection, not a stale trade. */
    maxMarketDataAgeMs: z.number().int().positive(),
    /** Observed execution latency above this trips the circuit breaker. */
    maxExecutionLatencyMs: z.number().int().positive(),
  })
  .strict();
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

/**
 * A rejection verdict with no breaches would be self-inconsistent, so the
 * fail-closed default names the reason explicitly.
 */
export function denyVerdict(
  base: Pick<RiskVerdict, 'verdictId' | 'correlationId' | 'intentId' | 'evaluatedAt'>,
  breaches: readonly [RiskBreach, ...RiskBreach[]],
): RiskVerdict {
  return RiskVerdictSchema.parse({
    ...base,
    approved: false,
    breaches: [...breaches],
    riskScore: 100,
  });
}