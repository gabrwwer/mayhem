/**
 * Research event taxonomy for the hardened execution pipeline.
 *
 * These events should eventually be emitted by the corresponding
 * execution/risk components so research.jsonl can distinguish:
 *
 * signal quality
 * from
 * execution quality
 * from
 * actual position outcome.
 */

export type ExecutionResearchEvent =
  | "QUALIFICATION_EVALUATED"
  | "ENTRY_SCORE_EVALUATED"
  | "ENTRY_REJECTED_OVEREXTENDED"
  | "POSITION_SIZE_CALCULATED"
  | "EXECUTION_PREFLIGHT"
  | "EXECUTION_REJECTED"
  | "ORDER_SUBMITTED"
  | "FILL_CONFIRMED"
  | "FILL_REJECTED"
  | "POST_FILL_REEVALUATION"
  | "PARTIAL_EXIT"
  | "PROFIT_LOCK"
  | "MOMENTUM_EXIT"
  | "LIQUIDITY_EMERGENCY_EXIT"
  | "POSITION_RECONCILIATION"
  | "RECONCILIATION_MISMATCH"
  | "RISK_LOCKOUT";

export interface ExecutionResearchBase {
  recordType: "EXECUTION";
  event: ExecutionResearchEvent;

  tokenMint: string;
  candidateId?: string;

  timestamp: number;

  decision: "PASS" | "REJECT" | "SUBMIT" | "HOLD" | "EXIT";

  reason: string;
}

export interface EntryQualityResearch extends ExecutionResearchBase {
  event: "ENTRY_SCORE_EVALUATED";

  entryScore: number;

  momentumScore: number;
  flowScore: number;
  liquidityScore: number;
  volumeScore: number;
  holderDistributionScore: number;
  executionScore: number;
  tokenSafetyScore: number;
}

export interface PositionSizeResearch extends ExecutionResearchBase {
  event: "POSITION_SIZE_CALCULATED";

  baseRiskBudgetSol: number;
  rawSizeSol: number;
  approvedSizeSol: number;

  confidenceMultiplier: number;
  liquidityFactor: number;
  momentumFactor: number;
  executionQualityFactor: number;
}

export interface FillResearch extends ExecutionResearchBase {
  event: "FILL_CONFIRMED" | "FILL_REJECTED";

  requestedSol: number;
  actualInputSol: number;
  actualOutputTokens: number;

  averageFillPrice: number;
  actualSlippagePct: number;

  feesSol: number;
  executionLatencyMs: number;
}
