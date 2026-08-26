import Decimal from 'decimal.js';

/**
 * Deterministic Mayhem position sizing.
 *
 * IMPORTANT:
 * - Momentum never overrides execution quality.
 * - Hard caps are always applied.
 * - This module only calculates size.
 * - It does not submit orders.
 */

export interface PositionSizingInput {
  baseRiskBudgetSol: string;

  confidenceMultiplier: number;
  liquidityFactor: number;
  momentumFactor: number;
  executionQualityFactor: number;

  minimumPositionSol: string;
  maximumPositionSol: string;

  remainingExposureSol: string;
  maximumExposureSol: string;
}

export interface PositionSizingResult {
  approved: boolean;
  rawSizeSol: string;
  approvedSizeSol: string;

  confidenceMultiplier: number;
  liquidityFactor: number;
  momentumFactor: number;
  executionQualityFactor: number;

  rejectionReason?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function d(value: string): Decimal {
  return new Decimal(value);
}

function minDecimal(...values: Decimal[]): Decimal {
  return values.reduce((min, value) => Decimal.min(min, value));
}

export function calculatePositionSize(
  input: PositionSizingInput,
): PositionSizingResult {
  const confidence = clamp(input.confidenceMultiplier, 0, 1);
  const liquidity = clamp(input.liquidityFactor, 0, 1);
  const momentum = clamp(input.momentumFactor, 0, 1);
  const execution = clamp(input.executionQualityFactor, 0, 1);

  if (execution <= 0) {
    return {
      approved: false,
      rawSizeSol: '0',
      approvedSizeSol: '0',
      confidenceMultiplier: confidence,
      liquidityFactor: liquidity,
      momentumFactor: momentum,
      executionQualityFactor: execution,
      rejectionReason: "EXECUTION_QUALITY_REJECTED",
    };
  }

  if (d(input.remainingExposureSol).lessThanOrEqualTo(0)) {
    return {
      approved: false,
      rawSizeSol: '0',
      approvedSizeSol: '0',
      confidenceMultiplier: confidence,
      liquidityFactor: liquidity,
      momentumFactor: momentum,
      executionQualityFactor: execution,
      rejectionReason: "EXPOSURE_LIMIT_REACHED",
    };
  }

  const rawSize = d(input.baseRiskBudgetSol)
    .times(confidence)
    .times(liquidity)
    .times(momentum)
    .times(execution);

  const exposureCap = minDecimal(
    d(input.maximumExposureSol),
    d(input.remainingExposureSol),
  );

  const cappedSize = minDecimal(
    rawSize,
    d(input.maximumPositionSol),
    exposureCap,
  );

  const approvedSize =
    cappedSize.greaterThanOrEqualTo(d(input.minimumPositionSol))
      ? cappedSize
      : new Decimal(0);

  return {
    approved: approvedSize.greaterThan(0),
    rawSizeSol: rawSize.toFixed(),
    approvedSizeSol: approvedSize.toFixed(),
    confidenceMultiplier: confidence,
    liquidityFactor: liquidity,
    momentumFactor: momentum,
    executionQualityFactor: execution,
    ...(approvedSize.greaterThan(0)
      ? {}
      : { rejectionReason: "POSITION_SIZE_BELOW_MINIMUM" }),
  };
}



