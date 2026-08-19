
import {
  AgentIdSchema,
  BasisPointsSchema,
  PublicKeySchema,
  RawAmountSchema,
  StrategyIdSchema,
  TimestampSchema,
} from '@mayhem/core-types';
import { z } from 'zod';

/**
 * Venue state for the mint being traded.
 *
 * Optional in {@link RiskContextSchema}: its absence is a rejection, not a
 * pass. Trading blind is the failure mode this engine exists to prevent.
 */
export const MarketSnapshotSchema = z
  .object({
    mint: PublicKeySchema,
    /** When the venue was observed. Age is checked against `maxMarketDataAgeMs`. */
    asOf: TimestampSchema,
    /** Depth of the pool the order would route through, in lamports. */
    poolLiquidityLamports: RawAmountSchema,
    /** Slippage the router expects for the requested size. */
    estimatedSlippageBps: BasisPointsSchema,
    /** 0-100 from the manipulation detector; detection only, never execution. */
    manipulationScore: z.number().min(0).max(100),
    /** A mint that cannot be sold is a donation, not a trade. */
    sellable: z.boolean(),
  })
  .strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const PortfolioSnapshotSchema = z
  .object({
    asOf: TimestampSchema,
    /** Current exposure to the mint being traded, in lamports. */
    positionLamports: RawAmountSchema,
    strategyExposureLamports: RawAmountSchema,
    globalExposureLamports: RawAmountSchema,
    /** Realized loss so far today, as a positive number. */
    dailyRealizedLossLamports: RawAmountSchema,
    peakEquityLamports: RawAmountSchema,
    currentEquityLamports: RawAmountSchema,
    consecutiveLosses: z.number().int().nonnegative(),
    /** Recently observed end-to-end execution latency. */
    observedExecutionLatencyMs: z.number().int().nonnegative(),
  })
  .strict();
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;

export const RiskContextSchema = z
  .object({
    now: TimestampSchema,
    /** Human-operated stop. When engaged, nothing trades. */
    killSwitchEngaged: z.boolean(),
    quarantinedAgents: z.array(AgentIdSchema),
    quarantinedStrategies: z.array(StrategyIdSchema),
    /** Order value in lamports, priced by the caller: the gate does not quote. */
    notionalLamports: RawAmountSchema,
    market: MarketSnapshotSchema.optional(),
    portfolio: PortfolioSnapshotSchema,
  })
  .strict();
export type RiskContext = z.infer<typeof RiskContextSchema>;