
import { z } from 'zod';
import {
  AgentIdSchema,
  BasisPointsSchema,
  BlockhashSchema,
  ConfidenceSchema,
  CorrelationIdSchema,
  EnvironmentSchema,
  PublicKeySchema,
  RawAmountSchema,
  SlotSchema,
  StrategyIdSchema,
  TimestampSchema,
  TokenAmountSchema,
  TransactionSignatureSchema,
} from './primitives.js';

export const SideSchema = z.enum(['buy', 'sell']);
export type Side = z.infer<typeof SideSchema>;

/**
 * An agent's request to trade. Agents may only ever produce intents: nothing
 * outside the execution service is permitted to sign or broadcast.
 */
export const OrderIntentSchema = z
  .object({
    intentId: z.string().uuid(),
    correlationId: CorrelationIdSchema,
    createdAt: TimestampSchema,
    /** Expiry after which the intent must be discarded rather than executed. */
    expiresAt: TimestampSchema,
    proposedBy: AgentIdSchema,
    strategyId: StrategyIdSchema,
    environment: EnvironmentSchema,
    side: SideSchema,
    inputMint: PublicKeySchema,
    outputMint: PublicKeySchema,
    /** Exact input amount, in the input mint's smallest unit. */
    amountIn: RawAmountSchema,
    /** Execution must abort if realized slippage would exceed this bound. */
    maxSlippageBps: BasisPointsSchema,
    /** Compute-unit price bid, in micro-lamports. */
    priorityFeeMicroLamports: z.number().int().nonnegative(),
    confidence: ConfidenceSchema,
    rationale: z.string().min(1).max(2_000),
  })
  .strict()
  .refine((intent) => intent.expiresAt > intent.createdAt, {
    message: 'expiresAt must be after createdAt',
    path: ['expiresAt'],
  })
  .refine((intent) => intent.inputMint !== intent.outputMint, {
    message: 'inputMint and outputMint must differ',
    path: ['outputMint'],
  });
export type OrderIntent = z.infer<typeof OrderIntentSchema>;

/**
 * Order lifecycle.
 *
 * `broadcast` is terminal-pending: the transaction is on the wire and its
 * outcome is unknown until confirmation or blockhash expiry. Restart
 * reconciliation must resolve every order left in this state.
 */
export const OrderStateSchema = z.enum([
  'pending_risk',
  'rejected_by_risk',
  'pending_approval',
  'rejected_by_approval',
  'simulating',
  'simulation_failed',
  'signing',
  'broadcast',
  'confirmed',
  'failed',
  'expired',
  'cancelled',
]);
export type OrderState = z.infer<typeof OrderStateSchema>;

const TERMINAL_STATES = new Set<OrderState>([
  'rejected_by_risk',
  'rejected_by_approval',
  'simulation_failed',
  'confirmed',
  'failed',
  'expired',
  'cancelled',
]);

const ORDER_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  pending_risk: ['rejected_by_risk', 'pending_approval', 'simulating', 'expired', 'cancelled'],
  rejected_by_risk: [],
  pending_approval: ['rejected_by_approval', 'simulating', 'expired', 'cancelled'],
  rejected_by_approval: [],
  simulating: ['simulation_failed', 'signing', 'expired', 'cancelled'],
  simulation_failed: [],
  signing: ['broadcast', 'failed', 'cancelled'],
  // No 'cancelled': once broadcast, the network decides the outcome.
  broadcast: ['confirmed', 'failed', 'expired'],
  confirmed: [],
  failed: [],
  expired: [],
  cancelled: [],
};

export function isTerminalOrderState(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** States whose outcome is unresolved and must be reconciled against the chain on restart. */
export function requiresReconciliation(state: OrderState): boolean {
  return state === 'signing' || state === 'broadcast';
}

export const OrderSchema = z
  .object({
    orderId: z.string().uuid(),
    /**
     * Deduplication key. The execution service must refuse to broadcast twice
     * for the same key so retries cannot double-fill.
     */
    idempotencyKey: z.string().min(16).max(128),
    intent: OrderIntentSchema,
    state: OrderStateSchema,
    updatedAt: TimestampSchema,
    signature: TransactionSignatureSchema.optional(),
    recentBlockhash: BlockhashSchema.optional(),
    lastValidBlockHeight: z.number().int().nonnegative().optional(),
    error: z.string().max(2_000).optional(),
  })
  .strict();
export type Order = z.infer<typeof OrderSchema>;

export const FillSchema = z
  .object({
    fillId: z.string().uuid(),
    orderId: z.string().uuid(),
    correlationId: CorrelationIdSchema,
    signature: TransactionSignatureSchema,
    slot: SlotSchema,
    blockTime: TimestampSchema,
    amountIn: TokenAmountSchema,
    amountOut: TokenAmountSchema,
    /** Transaction fee paid, in lamports. */
    feeLamports: RawAmountSchema,
    /** Signed difference between expected and realized output, in bps. */
    realizedSlippageBps: z.number().int(),
  })
  .strict();
export type Fill = z.infer<typeof FillSchema>;