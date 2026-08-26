/**
 * Mayhem position-management policy.
 *
 * The policy is deliberately deterministic.
 * Execution code should consume these decisions rather than inventing
 * its own exit behavior.
 */

export interface ProfitLadderLevel {
  triggerPct: number;
  sellPct: number;
}

export interface PositionManagerConfig {
  stopLossPct: number;
  ladder: readonly ProfitLadderLevel[];
  runnerPctTarget: number;
  stopCanOnlyMoveUp: boolean;
}

export interface PositionState {
  entryPrice: number;
  currentPrice: number;

  highestPrice: number;

  remainingPositionPct: number;

  lockedStopPrice: number | null;

  momentumDeteriorating: boolean;
  momentumReversed: boolean;
  liquidityDeteriorating: boolean;
}

export interface PositionDecision {
  action:
    | "HOLD"
    | "PARTIAL_EXIT"
    | "EXIT"
    | "EMERGENCY_EXIT";

  sellPct: number;
  reason: string;
}

export function evaluatePosition(
  config: PositionManagerConfig,
  state: PositionState,
): PositionDecision {
  if (state.liquidityDeteriorating) {
    return {
      action: "EMERGENCY_EXIT",
      sellPct: 100,
      reason: "LIQUIDITY_DETERIORATION",
    };
  }

  if (state.momentumReversed) {
    return {
      action: "EXIT",
      sellPct: 100,
      reason: "MOMENTUM_REVERSAL",
    };
  }

  if (state.entryPrice <= 0 || state.currentPrice <= 0) {
    return {
      action: "EMERGENCY_EXIT",
      sellPct: 100,
      reason: "INVALID_POSITION_PRICE",
    };
  }

  const pnlPct =
    ((state.currentPrice - state.entryPrice) /
      state.entryPrice) *
    100;

  if (pnlPct <= -Math.abs(config.stopLossPct)) {
    return {
      action: "EXIT",
      sellPct: 100,
      reason: "HARD_STOP_LOSS",
    };
  }

  if (state.momentumDeteriorating && pnlPct > 0) {
    return {
      action: "PARTIAL_EXIT",
      sellPct: Math.min(
        25,
        state.remainingPositionPct,
      ),
      reason: "MOMENTUM_DETERIORATION",
    };
  }

  for (const level of config.ladder) {
    if (pnlPct >= level.triggerPct) {
      const sellPct = Math.min(
        level.sellPct,
        Math.max(0, state.remainingPositionPct - config.runnerPctTarget),
      );

      if (sellPct > 0) {
        return {
          action: "PARTIAL_EXIT",
          sellPct,
          reason: `PROFIT_LOCK_${level.triggerPct}PCT`,
        };
      }
    }
  }

  return {
    action: "HOLD",
    sellPct: 0,
    reason: "POSITION_THESIS_INTACT",
  };
}
