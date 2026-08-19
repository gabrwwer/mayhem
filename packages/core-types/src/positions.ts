
import { z } from 'zod';
import {
  PublicKeySchema,
  RawAmountSchema,
  StrategyIdSchema,
  TimestampSchema,
  TokenAmountSchema,
} from './primitives.js';

export const PositionSchema = z
  .object({
    positionId: z.string().uuid(),
    strategyId: StrategyIdSchema,
    mint: PublicKeySchema,
    quantity: TokenAmountSchema,
    /** Volume-weighted average entry cost, in lamports. */
    costBasisLamports: RawAmountSchema,
    openedAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Position = z.infer<typeof PositionSchema>;

/**
 * Point-in-time profit and loss. Realized and unrealized are tracked
 * separately: a strategy is only profitable once fees and gas are subtracted,
 * so both are first-class rather than derived at display time.
 */
export const PnlSnapshotSchema = z
  .object({
    strategyId: StrategyIdSchema,
    asOf: TimestampSchema,
    realizedLamports: z.bigint(),
    unrealizedLamports: z.bigint(),
    feesLamports: RawAmountSchema,
    /** Priority fees and rent paid, tracked apart from protocol fees. */
    gasLamports: RawAmountSchema,
  })
  .strict();
export type PnlSnapshot = z.infer<typeof PnlSnapshotSchema>;

export function netPnlLamports(snapshot: PnlSnapshot): bigint {
  return (
    snapshot.realizedLamports +
    snapshot.unrealizedLamports -
    snapshot.feesLamports -
    snapshot.gasLamports
  );
}

/**
 * Result of comparing locally derived state against on-chain state. A drifted
 * reconciliation must alert rather than be silently corrected.
 */
export const ReconciliationResultSchema = z
  .object({
    reconciledAt: TimestampSchema,
    mint: PublicKeySchema,
    localQuantityRaw: RawAmountSchema,
    onChainQuantityRaw: RawAmountSchema,
    drifted: z.boolean(),
  })
  .strict()
  .refine((result) => result.drifted === (result.localQuantityRaw !== result.onChainQuantityRaw), {
    message: 'drifted must reflect the comparison of local and on-chain quantities',
    path: ['drifted'],
  });
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;