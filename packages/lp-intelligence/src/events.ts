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
import { DexSchema, type Dex } from './pool.js';
import { ObservedNumberSchema, type Observed } from './provenance.js';

export const LiquidityEventTypeSchema = z.enum([
  'LP_DETECTED',
  'LP_INITIALIZED',
  'RESERVE_CHANGE',
  'LIQUIDITY_ADDED',
  'LIQUIDITY_REMOVED',
  'LIQUIDITY_DEGRADED',
  'POOL_CLOSED',
]);
export type LiquidityEventType = z.infer<typeof LiquidityEventTypeSchema>;

export const EventSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

/**
 * A normalized liquidity event.
 *
 * `previousLiquidity` and `newLiquidity` are both `Observed<number>` rather
 * than plain numbers so an event assembled from a partially-readable pool
 * still carries what was known. An event whose new reading is UNAVAILABLE is
 * meaningful information — it says a pool we were tracking became unreadable —
 * and must not be discarded or backfilled with the previous value.
 *
 * `changePct` is null unless both sides were genuinely observed. Computing a
 * percentage against an estimate produces a number that looks authoritative
 * and is not.
 */
export interface LiquidityEvent {
  type: LiquidityEventType;
  severity: EventSeverity;
  poolAddress: PublicKey;
  tokenMint: PublicKey;
  dex: Dex;
  previousLiquidity: Observed<number> | null;
  newLiquidity: Observed<number>;
  /** newLiquidity - previousLiquidity, only when both were observed on chain. */
  delta: number | null;
  /** Percentage change, only when both sides were observed and the base is > 0. */
  changePct: number | null;
  slot: Slot | null;
  txSignature: TransactionSignature | null;
  observedAt: Timestamp;
  source: string;
  detail: string;
}

export const LiquidityEventSchema = z
  .object({
    type: LiquidityEventTypeSchema,
    severity: EventSeveritySchema,
    poolAddress: PublicKeySchema,
    tokenMint: PublicKeySchema,
    dex: DexSchema,
    previousLiquidity: ObservedNumberSchema.nullable(),
    newLiquidity: ObservedNumberSchema,
    delta: z.number().finite().nullable(),
    changePct: z.number().finite().nullable(),
    slot: SlotSchema.nullable(),
    txSignature: TransactionSignatureSchema.nullable(),
    observedAt: TimestampSchema,
    source: z.string().min(1).max(200),
    detail: z.string().min(1).max(500),
  })
  .strict();

/**
 * Compute delta and percentage change between two liquidity readings.
 *
 * Returns nulls unless **both** readings were observed on chain. This is the
 * rule that stops a "-100% liquidity" alert being generated because an RPC
 * call failed and returned nothing — a false rug signal is not a safe default.
 *
 * A previous reading of zero yields a null percentage rather than Infinity;
 * the absolute delta still carries the information.
 */
export function computeLiquidityChange(
  previous: Observed<number> | null,
  next: Observed<number>,
): { delta: number | null; changePct: number | null } {
  if (
    previous === null ||
    previous.provenance !== 'OBSERVED_ONCHAIN' ||
    previous.value === null ||
    next.provenance !== 'OBSERVED_ONCHAIN' ||
    next.value === null
  ) {
    return { delta: null, changePct: null };
  }

  const delta = next.value - previous.value;
  const changePct = previous.value > 0 ? (delta / previous.value) * 100 : null;

  return { delta, changePct };
}
