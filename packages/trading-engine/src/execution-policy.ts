/**
 * Bounded execution policy.
 *
 * This module determines whether an order is permitted to be submitted.
 * It does not perform the transaction itself.
 */

export interface ExecutionPreflight {
  quotedPrice: number;
  maximumAcceptablePrice: number;

  expectedSlippagePct: number;
  maximumSlippagePct: number;

  quoteAgeMs: number;
  maximumQuoteAgeMs: number;

  priceImpactBps: number;
  maximumPriceImpactBps: number;

  priorityFeeLamports: number;
  maximumPriorityFeeLamports: number;

  totalFeeSol: number;
  maximumTotalFeeSol: number;

  executionDeadlineMs: number;
}

export interface ExecutionDecision {
  approved: boolean;
  reason: string;
}

export function evaluateExecutionPreflight(
  input: ExecutionPreflight,
): ExecutionDecision {
  if (!Number.isFinite(input.quotedPrice) || input.quotedPrice <= 0) {
    return {
      approved: false,
      reason: "INVALID_QUOTE",
    };
  }

  if (input.quoteAgeMs > input.maximumQuoteAgeMs) {
    return {
      approved: false,
      reason: "QUOTE_EXPIRED",
    };
  }

  if (input.expectedSlippagePct > input.maximumSlippagePct) {
    return {
      approved: false,
      reason: "SLIPPAGE_EXCEEDED",
    };
  }

  if (input.priceImpactBps > input.maximumPriceImpactBps) {
    return {
      approved: false,
      reason: "PRICE_IMPACT_EXCEEDED",
    };
  }

  if (input.priorityFeeLamports > input.maximumPriorityFeeLamports) {
    return {
      approved: false,
      reason: "PRIORITY_FEE_EXCEEDED",
    };
  }

  if (input.totalFeeSol > input.maximumTotalFeeSol) {
    return {
      approved: false,
      reason: "TOTAL_FEE_EXCEEDED",
    };
  }

  if (input.executionDeadlineMs <= 0) {
    return {
      approved: false,
      reason: "INVALID_EXECUTION_DEADLINE",
    };
  }

  return {
    approved: true,
    reason: "EXECUTION_PREFLIGHT_PASSED",
  };
}
