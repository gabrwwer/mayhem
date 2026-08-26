
export interface TradingConfig {
  entryEnabled: boolean;
  maxPositionSol: number;
  takeProfitPercent: number;
  profitMonitorActivationPercent: number;
  profitLockActivationPercent: number;
  profitLockPercent: number;
  trailingActivationPercent: number;
  aggressiveTrailingActivationPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  maxHoldSeconds: number;
  maxOpenPositions: number;
  entryDelayMs: number;
  newLaunchMode: boolean;
  maxQuoteAgeMs: number;
  maxSellPriceImpactPercent: number;
  exitRetryMaxAttempts: number;
  exitRetryDelayMs: number;
  /** Hard stop loss percent (immediate exit when net P&L <= -hardStopLossPercent) */
  hardStopLossPercent: number;
  // Momentum exit confirmation window
  exitMomentumWindowMs?: number;
  exitMomentumSampleIntervalMs?: number;
  exitMomentumConfirmSamples?: number;
  exitMomentumBuyPressureThreshold?: number;
  exitMomentumSellPressureThreshold?: number;
  exitMomentumNetFlowPctThreshold?: number;

  /**
   * Minimum risk score required to open a position. Previously the engine
   * hardcoded `riskScore < 30` while the launch handler enforced
   * MIN_RISK_SCORE=70 — two different limits for the same decision, so the
   * dashboard showed one number and the engine applied another.
   */
  minRiskScore: number;

  /**
   * Share of observed pool liquidity a single entry may consume, in basis
   * points. Was hardcoded as `liquidity * 0.01`.
   */
  maxLiquidityParticipationBps: number;

  /**
   * Hard ceiling on how stale a price may be before it can still be used to
   * evaluate exit conditions. Beyond this the engine must not pretend it
   * knows the price — see MayhemEngine.monitorPositions.
   */
  maxPriceAgeMs: number;

  /**
   * How long to wait before re-evaluating a take-profit that was skipped
   * because net-of-fee P&L did not clear the threshold. Without this the
   * 250 ms monitor loop re-quotes on every tick forever.
   */
  takeProfitRetryDelayMs: number;
  /** Expected exit costs used only to establish a break-even protection floor. */
  expectedExitCostPercent?: number;
  /** Enables the existing confirmed momentum/volume reversal exit. */
  aggressiveExitOnMomentumReversal?: boolean;
}

export interface Position {
  id: string;
  tokenMint: string;

  /** Discovery / observed spot price before any trade decision is made. */
  observationPrice: DecimalValue;
  /** Signal / quote price used to evaluate whether the setup qualifies. */
  signalPrice: DecimalValue;
  /** Qualified entry price used for position bookkeeping and P&L baselines. */
  qualifiedEntryPrice: DecimalValue;
  /** Backward-compatible alias for the qualified entry price. */
  entryPrice: DecimalValue;
  /** Actual executed fill price that the chain settled on. */
  actualEntryPrice: DecimalValue;
  /** Explicit alias for the actual executed fill price. */
  executionPrice: DecimalValue;

  entryTime: Date;
  quantity: DecimalValue;
  /** Cost basis of the CURRENTLY held quantity. Shrinks on a partial exit. */
  entryNotional: DecimalValue;
  /**
   * Cost basis at open, never modified.
   *
   * `netPnlPercent` must divide by this. Using the live `entryNotional`
   * means that after a partial exit the denominator shrinks while realised
   * P&L keeps accumulating, so a second partial fill reports a wildly
   * inflated return percentage.
   */
  originalEntryNotional: DecimalValue;
  entryFees: DecimalValue;
  entryTx: string | null;
  currentPrice: DecimalValue;
  unrealizedPnl: DecimalValue;
  realizedPnl: DecimalValue;
  grossPnl: DecimalValue;
  netPnl: DecimalValue;
  netPnlPercent: DecimalValue;
  stopLoss: DecimalValue;
  takeProfit: DecimalValue;
  trailingStop: DecimalValue;
  trailingStopHighPrice: DecimalValue;
  profitLockActive: boolean;
  highestLockPercent: number;
  aggressiveTrailingActive: boolean;
  exitReason: string | null;
  exitTx: string | null;
  fees: DecimalValue;
  slippage: number;
  status: 'open' | 'closed' | 'exiting';
  exitAttemptCount: number;
  lastExitAttemptAt: Date | null;
  lastExitError: string | null;
  lastExitQuotePrice: DecimalValue | null;
  entryLiquidity: DecimalValue;

  /**
   * When `currentPrice` was last successfully refreshed.
   *
   * Without this the engine cannot distinguish "price is 0.9 and steady"
   * from "the feed died 10 minutes ago and 0.9 is the last thing we heard".
   * Stop-losses evaluated against a frozen price do not fire — precisely
   * during the outage when they matter most.
   */
  priceAsOf: number;

  /** Set when a take-profit was skipped on net P&L; gates re-evaluation. */
  takeProfitDeferredUntil: number | null;

  /**
   * Set when a stale-price force-exit failed; gates re-attempt.
   *
   * The condition that makes the price stale (a dead RPC) is usually the
   * same condition that makes the sell quote fail, so without this the
   * 250 ms monitor loop retries the exit four times a second against an
   * endpoint that is already failing — turning an outage into a
   * self-inflicted rate-limit.
   */
  staleExitDeferredUntil: number | null;
  /** Highest protected exit price established by profit management. */
  protectedFloorPrice?: DecimalValue;
  /** Explicit profit-management state for lifecycle and audit output. */
  profitManagementState?: 'INITIAL_DEVELOPMENT' | 'PROFIT_PROTECTION' | 'TRAILING';
  // Price history for MFE/MAE and return snapshots. Kept as [ts, price].
  priceHistory?: Array<{ ts: number; price: DecimalValue }>;
  peakPrice?: DecimalValue;
  troughPrice?: DecimalValue;
  mfePct?: DecimalValue;
  maePct?: DecimalValue;
  // Return snapshots (percent) at configured intervals, null if unavailable.
  returns?: Record<string, number | null>;
  holdDurationMs?: number;
}

/**
 * Persistence port for open positions.
 *
 * In-memory-only positions mean a restart orphans real holdings: no
 * stop-loss, no exit, and no record they exist. Implementations must be
 * durable; `@mayhem/database` provides the Postgres adapter.
 */
export interface PositionStore {
  loadOpen(): Promise<SerializedPosition[]>;
  saveOpen(positions: SerializedPosition[]): Promise<void>;
}

/** JSON-safe form of Position (Date fields become epoch millis). */
export type SerializedPosition = Omit<
  Position,
  'entryTime' | 'lastExitAttemptAt'
> & {
  entryTime: number;
  lastExitAttemptAt: number | null;
};

export interface TradeSignal {
  tokenMint: string;
  action: 'buy' | 'sell';
  reason: string;
  price: DecimalValue;
  amount: DecimalValue;
  timestamp: Date;
  entryLiquidity?: DecimalValue;
}

export interface ExitCondition {
  type: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_exit' | 'liquidity_exit' | 'volatility_exit' | 'emergency';
  triggered: boolean;
  value: DecimalValue;
}

export interface PositionUpdate {
  positionId: string;
  currentPrice: DecimalValue;
  unrealizedPnl: DecimalValue;
  exitConditions: ExitCondition[];
}

export interface SellQuote {
  outputAmount: DecimalValue;
  outputRawAmount?: bigint;
  pricePerToken: DecimalValue;
  priceImpactPct: DecimalValue;
  route: string;
  timestamp: number;
  estimatedFeeSol?: DecimalValue;
}

export interface NetPnlResult {
  grossProceeds: DecimalValue;
  estimatedSellFees: DecimalValue;
  estimatedPriceImpact: DecimalValue;
  netProceeds: DecimalValue;
  entryCost: DecimalValue;
  netPnl: DecimalValue;
  netPnlPercent: DecimalValue;
  quoteAgeMs: number;
  isStale: boolean;
  excessivePriceImpact: boolean;
}
import type { DecimalValue } from './calculations';
