/**
 * Runtime safety assertions.
 *
 * This module intentionally contains validation only.
 * It does not silently override strategy configuration.
 *
 * Safety-critical configuration must be normalized before
 * reaching the trading engine.
 */

export interface RuntimeSafetyConfig {
  maxPositionSol: number;
  maxOpenPositions: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingStopPercent?: number;
  maxHoldSeconds?: number;
}

export function assertRuntimeSafetyConfig(
  config: RuntimeSafetyConfig,
): RuntimeSafetyConfig {
  const errors: string[] = [];

  if (!Number.isFinite(config.maxPositionSol) || config.maxPositionSol <= 0) {
    errors.push("maxPositionSol must be > 0");
  }

  if (!Number.isFinite(config.maxOpenPositions) || config.maxOpenPositions < 1) {
    errors.push("maxOpenPositions must be >= 1");
  }

  if (!Number.isFinite(config.takeProfitPercent) || config.takeProfitPercent <= 0) {
    errors.push("takeProfitPercent must be > 0");
  }

  if (
    !Number.isFinite(config.stopLossPercent) ||
    config.stopLossPercent <= 0 ||
    config.stopLossPercent >= 100
  ) {
    errors.push("stopLossPercent must be > 0 and < 100");
  }

  if (
    config.trailingStopPercent !== undefined &&
    (!Number.isFinite(config.trailingStopPercent) ||
      config.trailingStopPercent <= 0 ||
      config.trailingStopPercent >= 100)
  ) {
    errors.push("trailingStopPercent must be > 0 and < 100");
  }

  if (
    config.maxHoldSeconds !== undefined &&
    (!Number.isFinite(config.maxHoldSeconds) ||
      config.maxHoldSeconds <= 0)
  ) {
    errors.push("maxHoldSeconds must be > 0");
  }

  if (errors.length > 0) {
    throw new Error(
      `Unsafe runtime trading configuration:\n- ${errors.join("\n- ")}`,
    );
  }

  return config;
}
