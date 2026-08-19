
import { z } from 'zod';
import {
  AgentIdSchema,
  ConfidenceSchema,
  CorrelationIdSchema,
  StrategyIdSchema,
  TimestampSchema,
} from './primitives.js';

export const RecommendationActionSchema = z.enum(['enter', 'exit', 'hold', 'avoid', 'quarantine']);
export type RecommendationAction = z.infer<typeof RecommendationActionSchema>;

export const RecommendationSchema = z
  .object({
    recommendationId: z.string().uuid(),
    correlationId: CorrelationIdSchema,
    producedBy: AgentIdSchema,
    strategyId: StrategyIdSchema,
    producedAt: TimestampSchema,
    action: RecommendationActionSchema,
    confidence: ConfidenceSchema,
    /** Inputs the recommendation was derived from, for the audit trail. */
    provenance: z.array(z.string().min(1).max(200)).min(1),
    rationale: z.string().min(1).max(2_000),
  })
  .strict();
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const DecisionOutcomeSchema = z.enum([
  'accepted',
  'rejected',
  'deferred_to_human',
  'superseded',
]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/**
 * A supervisor decision, as recorded in the append-only trail.
 *
 * `previousHash` chains entries so tampering is detectable, and `signature`
 * carries the signing-key attestation the agent manifest requires.
 */
export const DecisionRecordSchema = z
  .object({
    decisionId: z.string().uuid(),
    correlationId: CorrelationIdSchema,
    sequence: z.number().int().nonnegative(),
    decidedAt: TimestampSchema,
    decidedBy: AgentIdSchema,
    outcome: DecisionOutcomeSchema,
    /** Every recommendation considered, including the ones not chosen. */
    inputs: z.array(RecommendationSchema).min(1),
    selectedRecommendationId: z.string().uuid().optional(),
    /** Confidence margin between the top two candidates, used for adjudication. */
    confidenceMargin: z.number().min(0).max(1),
    rationale: z.string().min(1).max(4_000),
    /** Hex-encoded hash of the preceding entry; absent only for the genesis entry. */
    previousHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha-256 digest')
      .optional(),
    signature: z.string().min(1),
  })
  .strict()
  .refine(
    (record) => record.outcome !== 'accepted' || record.selectedRecommendationId !== undefined,
    {
      message: 'an accepted decision must name the selected recommendation',
      path: ['selectedRecommendationId'],
    },
  )
  .refine((record) => record.sequence !== 0 || record.previousHash === undefined, {
    message: 'only the genesis entry may omit previousHash',
    path: ['previousHash'],
  })
  .refine((record) => record.sequence === 0 || record.previousHash !== undefined, {
    message: 'non-genesis entries must chain to the preceding entry',
    path: ['previousHash'],
  });
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** Actions the supervisor manifest gates behind explicit human sign-off. */
export const ApprovalGateSchema = z.enum([
  'any_action_affecting_wallets',
  'escalation_to_executive_controls',
  'production_deploys_of_strategy',
  'changes_to_rbac_or_permissions',
]);
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;

export const ApprovalRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    correlationId: CorrelationIdSchema,
    gate: ApprovalGateSchema,
    requestedAt: TimestampSchema,
    /** A lapsed request must deny, never auto-approve. */
    expiresAt: TimestampSchema,
    requestedBy: AgentIdSchema,
    summary: z.string().min(1).max(2_000),
    status: z.enum(['pending', 'approved', 'denied', 'expired']),
    decidedBy: z.string().min(1).max(200).optional(),
    decidedAt: TimestampSchema.optional(),
  })
  .strict()
  .refine((request) => request.expiresAt > request.requestedAt, {
    message: 'expiresAt must be after requestedAt',
    path: ['expiresAt'],
  })
  .refine(
    (request) =>
      request.status === 'pending' ||
      request.status === 'expired' ||
      (request.decidedBy !== undefined && request.decidedAt !== undefined),
    {
      message: 'a decided request must record who decided it and when',
      path: ['decidedBy'],
    },
  );
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * Fail-closed resolution of an approval request: anything other than an
 * explicit approval recorded before the deadline is a denial. A request still
 * pending past its deadline resolves to denied rather than lingering.
 */
export function isApproved(request: ApprovalRequest): boolean {
  return (
    request.status === 'approved' &&
    request.decidedAt !== undefined &&
    request.decidedAt <= request.expiresAt
  );
}