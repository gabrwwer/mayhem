
import * as path from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import Decimal from 'decimal.js';
import {
  TradingConfig,
  TradeSignal,
  Position,
  PositionUpdate,
  NetPnlResult,
  SellQuote,
  ExitCondition,
} from './types';
import { PositionManager } from './position-manager';
import { isFilled, isUnresolved, ExecutionResult } from './execution-result';
import { ResearchRecorder, ResearchRecorderOptions } from './research-recorder';
import { PriceLifecycleEvent } from './research-metrics';
import { calculatePositionSize } from './position-sizing';
import { DecimalValue, parseAmount } from './calculations';

// Keep this module buildable in environments that do not include Node's
// ambient type definitions.
declare const process: {
  env: Record<string, string | undefined>;
};

/** Minimal EventEmitter implementation for builds without Node typings. */
class EventEmitter {
  private readonly listeners = new Map<string | symbol, Set<(...args: any[]) => void>>();

  on(event: string | symbol, listener: (...args: any[]) => void): this {
    let eventListeners = this.listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }
    eventListeners.add(listener);
    return this;
  }

  once(event: string | symbol, listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]): void => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string | symbol, listener: (...args: any[]) => void): this {
    const eventListeners = this.listeners.get(event);
    eventListeners?.delete(listener);
    if (eventListeners?.size === 0) this.listeners.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: any[]): boolean {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners?.size) return false;
    for (const listener of [...eventListeners]) listener(...args);
    return true;
  }
}

/** Minimal structured-logger contract. */
export interface EngineLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * The state that caused an exit, captured at the moment it fired.
 *
 * Held separately from the Position because `closePosition` overwrites
 * `currentPrice` with the realised exit price — so by the time the fill is
 * booked, the price that triggered the exit is no longer recoverable from
 * the position itself.
 */
interface ExitTrigger {
  /** Epoch millis at which the exit condition fired. */
  at: number;
  /** Last known market price when the condition fired. */
  price: DecimalValue;
  /** The level the condition tested against, or null if not price-based. */
  threshold: DecimalValue | null;
}

/**
 * The price level whose breach caused this exit.
 *
 * `time_exit` and `stale_price` are not price-based, so they have no
 * threshold — reporting one would invite a meaningless comparison.
 */
function thresholdForReason(position: Position, reason: string): DecimalValue | null {
  switch (reason) {
    case 'stop_loss':
      return position.stopLoss;
    case 'take_profit':
      return position.takeProfit;
    case 'trailing_stop':
      return position.trailingStop;
    default:
      return null;
  }
}

/**
 * Tracks lifecycle prices and events for research recording.
 * Gets populated as the position moves through discovery → signal → qualification → execution.
 */
interface PositionLifecycleTracking {
  tokenMint: string;
  observationPrice: DecimalValue;
  observationTime: number;
  signalPrice?: DecimalValue;
  signalTime?: number;
  qualificationTime?: number;
  executionTime?: number;
  executionPrice?: DecimalValue;
  priceHistory: Array<{ timestamp: number; price: DecimalValue }>;
}

/**
 * Percentage change from `from` to `to`.
 *
 * Returns null rather than Infinity/NaN on a zero or non-finite base: a
 * missing measurement must be distinguishable from a measured zero, because
 * these values are averaged downstream.
 */
function pctChange(from: DecimalValue | null, to: DecimalValue): number | null {
  if (from === null) return null;
  try {
    const base = parseAmount(from);
    const target = parseAmount(to);
    if (!base.isFinite() || base.isZero() || !target.isFinite()) return null;
    return Number(target.minus(base).div(base).times(100).toFixed(4));
  } catch {
    return null;
  }
}

function decimalString(value: Decimal): DecimalValue {
  return value.toFixed();
}

function isPositiveDecimal(value: DecimalValue): boolean {
  try {
    const decimal = parseAmount(value);
    return decimal.isFinite() && decimal.greaterThan(0);
  } catch {
    return false;
  }
}

function isNonNegativeDecimal(value: DecimalValue): boolean {
  try {
    const decimal = parseAmount(value);
    return decimal.isFinite() && decimal.greaterThanOrEqualTo(0);
  } catch {
    return false;
  }
}

function decimalToNumberForResearch(value: DecimalValue): number {
  return Number(parseAmount(value).toFixed(12));
}

export class MayhemEngine extends EventEmitter {
  /** Keep event emission available under projects with incomplete Node typings. */
  public override emit(event: string | symbol, ...args: any[]): boolean {
    return EventEmitter.prototype.emit.call(this, event, ...args);
  }

  private config: TradingConfig;
  private positionManager: PositionManager;
  private executionEngine: any;
  private riskEngine: any;
  private logger: EngineLogger;
  private researchRecorder: ResearchRecorder;
  private running = false;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private monitoring = false;
  private entryInFlight = false;
  private exitingPositions = new Set<string>();
  // Momentum confirmation state per position.
  private momentumState: Map<string, { count: number; lastSampleTs: number }> = new Map();
  // Lifecycle tracking per position ID for research recording
  private lifecycleTracking: Map<string, PositionLifecycleTracking> = new Map();

  constructor(
    config: TradingConfig,
    positionManager: PositionManager,
    executionEngine: any,
    riskEngine: any,
    /**
     * Injected so engine output goes through the same structured, redacting
     * logger as the rest of the bot. Defaults to console for tests only.
     */
    logger?: EngineLogger,
    researchRecorderOptions?: ResearchRecorderOptions,
  ) {
    super();
    this.config = config;
    this.positionManager = positionManager;
    this.executionEngine = executionEngine;
    this.riskEngine = riskEngine;
    this.logger = logger ?? consoleLogger();
    // Initialize research recorder for data collection
    // Use repo root as default if no explicit path given
    const runtime = globalThis as typeof globalThis & {
      process?: {
        cwd?: () => string;
        env?: Record<string, string | undefined>;
      };
    };
    const defaultResearchPath = path.join(
      runtime.process?.cwd?.() ?? '.',
      'data',
      'research.jsonl',
    );
    this.researchRecorder = new ResearchRecorder(
      researchRecorderOptions || {
        filePath: defaultResearchPath,
        dryRun: runtime.process?.env?.['DRY_RUN'] === 'true',
        tradingEnabled: runtime.process?.env?.['TRADING_ENABLED'] === 'true',
      },
    );
    // ensure momentumState map fresh
    this.momentumState = new Map();
  }

  get isRunning(): boolean {
    return this.running;
  }

  getResearchRecorder(): ResearchRecorder {
    return this.researchRecorder;
  }

  evaluateToken(
    tokenMint: string,
    price: DecimalValue,
    liquidity: DecimalValue,
    riskScore: number,
    options?: {
      /**
       * True only when the caller successfully READ the venue's depth and the
       * value it read was zero — i.e. a bonding curve at launch.
       *
       * Defaults to false, so every existing caller keeps the original
       * fail-closed behaviour. Never set this because depth was unavailable,
       * errored, or was assumed: that is the exact condition the zero-depth
       * rejection exists to catch.
       */
      depthMeasured?: boolean;
    },
  ): TradeSignal | null {
    if (!this.config.entryEnabled) {
      // Record entry rejection for research
      if (this.researchRecorder) {
        try {
          this.researchRecorder.recordDecision({
            recordId: `entry-reject:${tokenMint}:${Date.now()}`,
            tokenMint: tokenMint,
            mint: tokenMint,
            decision: 'REJECT',
            reason: 'entry_disabled',
            priceAtDecision: price,
            liquidityAtDecision: liquidity,
            // Comprehensive scoring - set to null when not measured
            momentumScore: null,
            volumeScore: null,
            liquidityScore: null,
            trendScore: null,
            flowScore: null,
            executionScore: null,
            overallScore: null,
            // Risk breakdown - set to null when not measured
            riskScore: null,
            riskComponents: {
              liquidityRisk: null,
              volumeRisk: null,
              momentumRisk: null,
              holderRisk: null,
              volatilityRisk: null,
              executionRisk: null,
            },
            // Entry-specific data (none available for this early rejection)
            entrySignal: null,
            entrySignalStrength: null,
            // Additional decision context
            netFlowPct: null,
            priceChangePct: null,
            transactionVelocity: null,
            uniqueBuyers: null,
            uniqueSellers: null,
            largestBuySol: null,
            largestSellSol: null,
            topBuyerConcentration: null,
            buyVolumeSol: null,
            sellVolumeSol: null,
            buySellVolumeRatio: null,
            curveProgressPct: null,
            poolLiquidity: null,
            curveDepthSol: null,
            curveReserveSol: null,
            buyerGrowthScore: null,
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
            tokenMint: tokenMint,
            decision: 'REJECT',
            reason: 'entry_disabled',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
      }
      return null;
    }

    if (this.entryInFlight) {
      // Surfaced rather than silently dropped: under a burst of launches
      // this is the reason most candidates never trade, and an operator
      // tuning the bot needs to see it.
      this.logger.info('SIGNAL_SKIPPED', { tokenMint, reason: 'entry_in_flight' });

      // Record entry rejection for research
      if (this.researchRecorder) {
        try {
          this.researchRecorder.recordDecision({
            recordId: `entry-reject:${tokenMint}:${Date.now()}`,
            tokenMint: tokenMint,
            mint: tokenMint,
            decision: 'REJECT',
            reason: 'entry_in_flight',
            priceAtDecision: price,
            liquidityAtDecision: liquidity,
            // Comprehensive scoring - set to null when not measured
            momentumScore: null,
            volumeScore: null,
            liquidityScore: null,
            trendScore: null,
            flowScore: null,
            executionScore: null,
            overallScore: null,
            // Risk breakdown - set to null when not measured
            riskScore: null,
            riskComponents: {
              liquidityRisk: null,
              volumeRisk: null,
              momentumRisk: null,
              holderRisk: null,
              volatilityRisk: null,
              executionRisk: null,
            },
            // Entry-specific data (none available for this early rejection)
            entrySignal: null,
            entrySignalStrength: null,
            // Additional decision context
            netFlowPct: null,
            priceChangePct: null,
            transactionVelocity: null,
            uniqueBuyers: null,
            uniqueSellers: null,
            largestBuySol: null,
            largestSellSol: null,
            topBuyerConcentration: null,
            buyVolumeSol: null,
            sellVolumeSol: null,
            buySellVolumeRatio: null,
            curveProgressPct: null,
            poolLiquidity: null,
            curveDepthSol: null,
            curveReserveSol: null,
            buyerGrowthScore: null,
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
            tokenMint: tokenMint,
            decision: 'REJECT',
            reason: 'entry_in_flight',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
      }

      return null;
    }

    if (!this.positionManager.canOpenPosition()) {
      this.logger.info('SIGNAL_SKIPPED', { tokenMint, reason: 'max_open_positions' });

      // Record entry rejection for research
      if (this.researchRecorder) {
        try {
          this.researchRecorder.recordDecision({
            recordId: `entry-reject:${tokenMint}:${Date.now()}`,
            tokenMint: tokenMint,
            mint: tokenMint,
            decision: 'REJECT',
            reason: 'max_open_positions',
            priceAtDecision: price,
            liquidityAtDecision: liquidity,
            // Comprehensive scoring - set to null when not measured
            momentumScore: null,
            volumeScore: null,
            liquidityScore: null,
            trendScore: null,
            flowScore: null,
            executionScore: null,
            overallScore: null,
            // Risk breakdown - set to null when not measured
            riskScore: null,
            riskComponents: {
              liquidityRisk: null,
              volumeRisk: null,
              momentumRisk: null,
              holderRisk: null,
              volatilityRisk: null,
              executionRisk: null,
            },
            // Entry-specific data (none available for this early rejection)
            entrySignal: null,
            entrySignalStrength: null,
            // Additional decision context
            netFlowPct: null,
            priceChangePct: null,
            transactionVelocity: null,
            uniqueBuyers: null,
            uniqueSellers: null,
            largestBuySol: null,
            largestSellSol: null,
            topBuyerConcentration: null,
            buyVolumeSol: null,
            sellVolumeSol: null,
            buySellVolumeRatio: null,
            curveProgressPct: null,
            poolLiquidity: null,
            curveDepthSol: null,
            curveReserveSol: null,
            buyerGrowthScore: null,
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
            tokenMint: tokenMint,
            decision: 'REJECT',
            reason: 'max_open_positions',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
      }

      return null;
    }

    if (!Number.isFinite(riskScore) || riskScore < this.config.minRiskScore) {
      this.logger.info('SIGNAL_SKIPPED', {
        tokenMint,
        reason: 'risk_score_below_minimum',
        riskScore,
        minRiskScore: this.config.minRiskScore,
      });

      // Record entry rejection for research
      if (this.researchRecorder) {
        try {
          this.researchRecorder.recordDecision({
            recordId: `entry-reject:${tokenMint}:${Date.now()}`,
            tokenMint: tokenMint,
            mint: tokenMint,
            decision: 'REJECT',
            reason: 'risk_score_below_minimum',
            priceAtDecision: price,
            liquidityAtDecision: liquidity,
            // Risk score is known for this rejection
            riskScore: riskScore,
            // Risk breakdown - set to null when not measured
            riskComponents: {
              liquidityRisk: null,
              volumeRisk: null,
              momentumRisk: null,
              holderRisk: null,
              volatilityRisk: null,
              executionRisk: null,
            },
            // Other scoring - set to null when not measured
            momentumScore: null,
            volumeScore: null,
            liquidityScore: null,
            trendScore: null,
            flowScore: null,
            executionScore: null,
            overallScore: null,
            // Entry-specific data (none available for this early rejection)
            entrySignal: null,
            entrySignalStrength: null,
            // Additional decision context
            netFlowPct: null,
            priceChangePct: null,
            transactionVelocity: null,
            uniqueBuyers: null,
            uniqueSellers: null,
            largestBuySol: null,
            largestSellSol: null,
            topBuyerConcentration: null,
            buyVolumeSol: null,
            sellVolumeSol: null,
            buySellVolumeRatio: null,
            curveProgressPct: null,
            poolLiquidity: null,
            curveDepthSol: null,
            curveReserveSol: null,
            buyerGrowthScore: null,
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
            tokenMint: tokenMint,
            decision: 'REJECT',
            reason: 'risk_score_below_minimum',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
      }

      return null;
    }

    if (!isPositiveDecimal(price)) {
      this.logger.warn('SIGNAL_SKIPPED', { tokenMint, reason: 'invalid_price', price });

      // Record entry rejection for research
      if (this.researchRecorder) {
        try {
          this.researchRecorder.recordDecision({
            recordId: `entry-reject:${tokenMint}:${Date.now()}`,
            tokenMint: tokenMint,
            mint: tokenMint,
            decision: 'REJECT',
            reason: 'invalid_price',
            priceAtDecision: price,
            liquidityAtDecision: liquidity,
            // Comprehensive scoring - set to null when not measured
            momentumScore: null,
            volumeScore: null,
            liquidityScore: null,
            trendScore: null,
            flowScore: null,
            executionScore: null,
            overallScore: null,
            // Risk breakdown - set to null when not measured
            riskScore: null,
            riskComponents: {
              liquidityRisk: null,
              volumeRisk: null,
              momentumRisk: null,
              holderRisk: null,
              volatilityRisk: null,
              executionRisk: null,
            },
            // Entry-specific data (none available for this early rejection)
            entrySignal: null,
            entrySignalStrength: null,
            // Additional decision context
            netFlowPct: null,
            priceChangePct: null,
            transactionVelocity: null,
            uniqueBuyers: null,
            uniqueSellers: null,
            largestBuySol: null,
            largestSellSol: null,
            topBuyerConcentration: null,
            buyVolumeSol: null,
            sellVolumeSol: null,
            buySellVolumeRatio: null,
            curveProgressPct: null,
            poolLiquidity: null,
            curveDepthSol: null,
            curveReserveSol: null,
            buyerGrowthScore: null,
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
            tokenMint: tokenMint,
            decision: 'REJECT',
            reason: 'invalid_price',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
      }

      return null;
    }

    if (
      !Number.isFinite(this.config.maxPositionSol) ||
      this.config.maxPositionSol <= 0 ||
      !Number.isFinite(this.config.maxLiquidityParticipationBps) ||
      this.config.maxLiquidityParticipationBps <= 0 ||
      this.config.maxLiquidityParticipationBps > 10_000
    ) {
      this.logger.error('SIGNAL_SKIPPED', {
        tokenMint,
        reason: 'invalid_entry_sizing_config',
        maxPositionSol: this.config.maxPositionSol,
        maxLiquidityParticipationBps: this.config.maxLiquidityParticipationBps,
      });
      return null;
    }

    // Fail closed on unmeasurable liquidity.
    //
    // This previously fell back to `maxPositionSol` — i.e. "we could not
    // measure the pool" resolved to "trade it at full size, uncapped". That
    // is the one path by which a position can be opened with no relationship
    // to the depth it must later be sold into, and the exit impact it causes
    // is what makes a stop-loss fill far below its trigger.
    //
    // Skipping costs a missed entry. The alternative costs an unbounded exit.
    //
    // `depthMeasured` is the ONE exception, and it is narrow: the caller has
    // successfully read the bonding curve and observed reserves of zero,
    // which is the normal state of a curve nobody has bought yet. That is a
    // measurement, not a failure to measure, and rejecting it made
    // launch-time entry structurally impossible. A caller that could not read
    // the curve at all must still pass `depthMeasured: false` (the default)
    // and is still rejected here.
    const depthMeasured = options?.depthMeasured === true;

    if (!isNonNegativeDecimal(liquidity)) {
      this.logger.warn('SIGNAL_SKIPPED', {
        tokenMint,
        reason: 'liquidity_invalid',
        liquidity,
      });

      // Record entry rejection for research
      if (this.researchRecorder) {
        try {
          this.researchRecorder.recordDecision({
            recordId: `entry-reject:${tokenMint}:${Date.now()}`,
            tokenMint: tokenMint,
            mint: tokenMint,
            decision: 'REJECT',
            reason: 'liquidity_invalid',
            priceAtDecision: price,
            liquidityAtDecision: liquidity,
            // Comprehensive scoring - set to null when not measured
            momentumScore: null,
            volumeScore: null,
            liquidityScore: null,
            trendScore: null,
            flowScore: null,
            executionScore: null,
            overallScore: null,
            // Risk breakdown - set to null when not measured
            riskScore: null,
            riskComponents: {
              liquidityRisk: null,
              volumeRisk: null,
              momentumRisk: null,
              holderRisk: null,
              volatilityRisk: null,
              executionRisk: null,
            },
            // Entry-specific data (none available for this early rejection)
            entrySignal: null,
            entrySignalStrength: null,
            // Additional decision context
            netFlowPct: null,
            priceChangePct: null,
            transactionVelocity: null,
            uniqueBuyers: null,
            uniqueSellers: null,
            largestBuySol: null,
            largestSellSol: null,
            topBuyerConcentration: null,
            buyVolumeSol: null,
            sellVolumeSol: null,
            buySellVolumeRatio: null,
            curveProgressPct: null,
            poolLiquidity: null,
            curveDepthSol: null,
            curveReserveSol: null,
            buyerGrowthScore: null,
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
            tokenMint: tokenMint,
            decision: 'REJECT',
            reason: 'liquidity_invalid',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
      }

      return null;
    }

    if (parseAmount(liquidity).lessThanOrEqualTo(0) && !depthMeasured) {
      this.logger.warn('SIGNAL_SKIPPED', {
        tokenMint,
        reason: 'liquidity_unknown',
        liquidity,
      });

      // Record entry rejection for research
      if (this.researchRecorder) {
        try {
          this.researchRecorder.recordDecision({
            recordId: `entry-reject:${tokenMint}:${Date.now()}`,
            tokenMint: tokenMint,
            mint: tokenMint,
            decision: 'REJECT',
            reason: 'liquidity_unknown',
            priceAtDecision: price,
            liquidityAtDecision: liquidity,
            // Comprehensive scoring - set to null when not measured
            momentumScore: null,
            volumeScore: null,
            liquidityScore: null,
            trendScore: null,
            flowScore: null,
            executionScore: null,
            overallScore: null,
            // Risk breakdown - set to null when not measured
            riskScore: null,
            riskComponents: {
              liquidityRisk: null,
              volumeRisk: null,
              momentumRisk: null,
              holderRisk: null,
              volatilityRisk: null,
              executionRisk: null,
            },
            // Entry-specific data (none available for this early rejection)
            entrySignal: null,
            entrySignalStrength: null,
            // Additional decision context
            netFlowPct: null,
            priceChangePct: null,
            transactionVelocity: null,
            uniqueBuyers: null,
            uniqueSellers: null,
            largestBuySol: null,
            largestSellSol: null,
            topBuyerConcentration: null,
            buyVolumeSol: null,
            sellVolumeSol: null,
            buySellVolumeRatio: null,
            curveProgressPct: null,
            poolLiquidity: null,
            curveDepthSol: null,
            curveReserveSol: null,
            buyerGrowthScore: null,
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
            tokenMint: tokenMint,
            decision: 'REJECT',
            reason: 'liquidity_unknown',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
      }

      return null;
    }

    /*
     * Two sizing bases, deliberately kept distinct.
     *
     * Depth-based (participation cap) is the safer rule and stays the default
     * wherever depth exists: it bounds how much of the pool this position
     * must later be sold back into.
     *
     * Fixed first-buy budget applies only when depth is measured at zero — a
     * curve at launch. There is nothing to take a percentage OF, so the
     * constraint becomes the absolute amount of capital we are willing to
     * lose on one launch. That is `maxPositionSol`, and every other control
     * (max open positions, max exposure, daily loss, drawdown, consecutive
     * losses) still applies on top of it, unchanged.
     *
     * RESIDUAL RISK, stated plainly: on a zero-depth curve this position is
     * initially a large share of the curve, so the exit-impact guarantee the
     * participation cap provides does NOT hold at entry. The strategy assumes
     * the curve deepens before exit. If it does not, the exit fills poorly.
     * This is an accepted, operator-approved tradeoff for launch entry — it
     * is not a bug, and it must not be quietly extended to any other venue.
     */
    /*
     * Deterministic dynamic sizing.
     *
     * The position-sizing engine is now the single authority for the
     * calculated entry amount. The existing liquidity participation cap
     * remains a hard upper bound and is passed through as the effective
     * maximum position.
     *
     * IMPORTANT:
     * - Momentum can reduce/increase the calculated size only through its
     *   normalized factor.
     * - Momentum never bypasses execution quality.
     * - Liquidity participation remains a hard cap.
     * - maxPositionSol remains an absolute hard cap.
     */

    const participationCap =
      parseAmount(liquidity).greaterThan(0)
        ? decimalString(parseAmount(liquidity).times(this.config.maxLiquidityParticipationBps).div(10_000))
        : this.config.maxPositionSol.toString();

    const effectiveMaximumPositionSol = decimalString(Decimal.min(
      new Decimal(this.config.maxPositionSol),
      parseAmount(participationCap),
    ));

    const sizing = calculatePositionSize({
      baseRiskBudgetSol: this.config.maxPositionSol.toString(),

      /*
       * These values are normalized safety factors. Risk score remains a
       * sizing factor for positive-depth venues; measured zero-depth launch
       * entries use the documented fixed first-buy budget.
       */
      // A successfully measured zero-depth bonding curve uses the documented
      // fixed first-buy budget. Risk and portfolio gates have already passed;
      // do not multiply that fixed budget by the score a second time.
      confidenceMultiplier:
        depthMeasured && parseAmount(liquidity).lessThanOrEqualTo(0)
          ? 1
          : Math.max(0, Math.min(1, riskScore / 100)),
      liquidityFactor:
        parseAmount(liquidity).greaterThan(0)
          ? Math.max(0, Math.min(1, decimalToNumberForResearch(decimalString(parseAmount(liquidity).div(3)))))
          : depthMeasured
            ? 1
            : 0,
      momentumFactor: 1,
      executionQualityFactor: 1,

      minimumPositionSol: '0',
      maximumPositionSol: effectiveMaximumPositionSol,

      /*
       * The engine's existing exposure/risk governors remain authoritative.
       * This stage only adds deterministic sizing.
       */
      remainingExposureSol: this.config.maxPositionSol.toString(),
      maximumExposureSol: this.config.maxPositionSol.toString(),
    });

    const amount = sizing.approvedSizeSol;

    const sizingBasis: 'depth_participation' | 'fixed_first_buy' =
      parseAmount(liquidity).greaterThan(0)
        ? 'depth_participation'
        : 'fixed_first_buy';

    if (!sizing.approved || !isPositiveDecimal(amount)) {
      this.logger.info('SIGNAL_SKIPPED', {
        tokenMint,
        reason: sizing.rejectionReason ?? 'zero_size_after_caps',
        sizing,
      });
      return null;
    }

    this.logger.info('POSITION_SIZE_CALCULATED', {
      tokenMint,
      amount,
      rawSizeSol: sizing.rawSizeSol,
      approvedSizeSol: sizing.approvedSizeSol,
      confidenceMultiplier: sizing.confidenceMultiplier,
      liquidityFactor: sizing.liquidityFactor,
      momentumFactor: sizing.momentumFactor,
      executionQualityFactor: sizing.executionQualityFactor,
      sizingBasis,
      participationCap,
      maximumPositionSol: this.config.maxPositionSol,
    });

    const signal: TradeSignal = {
      tokenMint,
      action: 'buy',
      // Record the sizing basis in the signal itself. Post-trade analysis has
      // to be able to separate fixed-budget launch entries from depth-sized
      // ones — they are different risk profiles and pooling their P&L would
      // hide which of the two actually works.
      reason: `Risk score ${riskScore}, liquidity ${liquidity}, sizing ${sizingBasis}`,
      price,
      amount,
      timestamp: new Date(),
      entryLiquidity: liquidity,
    };

    // Track observation at discovery time if this is new
    const now = Date.now();
    if (!this.lifecycleTracking.has(tokenMint)) {
      this.lifecycleTracking.set(tokenMint, {
        tokenMint,
        observationPrice: price,
        observationTime: now,
        priceHistory: [{ timestamp: now, price }],
      });
    }

    // Track signal at generation time
    const tracking = this.lifecycleTracking.get(tokenMint);
    if (tracking) {
      tracking.signalPrice = price;
      tracking.signalTime = now;
    }

    // Call the inherited emitter explicitly so this remains compatible with
    // runtimes whose EventEmitter type does not expose `emit` on subclasses.
    EventEmitter.prototype.emit.call(this, 'signal', signal);

    // Record BUY decision for research
    if (this.researchRecorder) {
      try {
        this.researchRecorder.recordDecision({
          recordId: `entry-buy:${tokenMint}:${Date.now()}`,
          tokenMint: tokenMint,
          mint: tokenMint,
          decision: 'BUY',
          reason: `Risk score ${riskScore}, liquidity ${liquidity}, sizing ${sizingBasis}`,
          priceAtDecision: price,
          liquidityAtDecision: liquidity,
          // Risk score is known for this decision
          riskScore: riskScore,
          // Other scoring - set to null when not measured (would need actual data sources)
          momentumScore: null,
          volumeScore: null,
          liquidityScore: null,
          trendScore: null,
          flowScore: null,
          executionScore: null,
          overallScore: null,
          // Risk breakdown - set to null when not measured
          riskComponents: {
            liquidityRisk: null,
            volumeRisk: null,
            momentumRisk: null,
            holderRisk: null,
            volatilityRisk: null,
            executionRisk: null,
          },
          // Entry-specific data
          entrySignal: signal.reason, // The reason field contains our decision rationale
          entrySignalStrength: null, // Would need actual signal strength measurement
          // Additional decision context (would need actual data sources)
          netFlowPct: null,
          priceChangePct: null,
          transactionVelocity: null,
          uniqueBuyers: null,
          uniqueSellers: null,
          largestBuySol: null,
          largestSellSol: null,
          topBuyerConcentration: null,
          buyVolumeSol: null,
          sellVolumeSol: null,
          buySellVolumeRatio: null,
          curveProgressPct: null,
          poolLiquidity: null,
          curveDepthSol: null,
          curveReserveSol: null,
          buyerGrowthScore: null,
        });
      } catch (recordError) {
        this.logger.warn('RESEARCH_RECORD_ENTRY_DECISION_FAILED', {
          tokenMint: tokenMint,
          decision: 'BUY',
          reason: `Risk score ${riskScore}, liquidity ${liquidity}, sizing ${sizingBasis}`,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }
    }

    return signal;
  }

  async executeEntry(signal: TradeSignal): Promise<Position | null> {
    if (this.entryInFlight) return null;
    this.entryInFlight = true;

    try {
      // A position may ONLY be opened against a confirmed on-chain fill.
      //
      // The previous logic opened a position whenever the result was not
      // literally `'failed'` — so 'pending', 'expired', an unrecognised
      // status, or a missing execution engine all booked a position the
      // wallet might not hold. Everything below fails closed instead.
      if (!this.executionEngine) {
        this.logger.error('ENTRY_ABORTED', {
          mint: signal.tokenMint,
          reason: 'no_execution_engine',
        });
        return null;
      }

      const canPumpBuy =
        typeof this.executionEngine.executePumpFunBuy === 'function' &&
        signal.tokenMint.endsWith('pump');
      const canGenericBuy = typeof this.executionEngine.quoteBuy === 'function';

      if (!canPumpBuy && !canGenericBuy) {
        this.logger.error('ENTRY_ABORTED', {
          mint: signal.tokenMint,
          reason: 'execution_engine_exposes_no_buy_path',
        });
        return null;
      }

      // Only quote when the engine actually exposes quoting. A pump-only
      // venue (executePumpFunBuy present, quoteBuy absent) passed the guard
      // above and then hit an unconditional quoteBuy call, throwing a
      // TypeError that the catch below would have reported as ENTRY_ERROR —
      // an execution bug disguised as a trading failure.
      const quote = canGenericBuy
        ? await this.executionEngine.quoteBuy(signal.tokenMint, signal.amount)
        : null;

      const quotedPriceRaw = quote?.pricePerToken;
      const quotedPrice =
        typeof quotedPriceRaw === 'string' &&
        isPositiveDecimal(quotedPriceRaw)
          ? quotedPriceRaw
          : signal.price;

      let result: ExecutionResult | null;
      if (canPumpBuy) {
        result = await this.executionEngine.executePumpFunBuy(
          signal.tokenMint,
          signal.amount,
        );
      } else {
        const tx = await this.executionEngine.buildBuyTransaction(quote);
        result = await this.executionEngine.signAndSendTransaction(tx);
      }

      if (!isFilled(result)) {
        this.logger.warn('ENTRY_NOT_FILLED', {
          mint: signal.tokenMint,
          status: result?.status ?? 'no_result',
          signature: result?.signature ?? null,
          error: result?.error ?? null,
        });

        // Record the failed execution attempt in research dataset
        try {
          this.researchRecorder.recordExecution({
            tokenMint: signal.tokenMint,
            mint: signal.tokenMint,
            executionStatus: 'FAILED',
            reason: result?.error ?? result?.status ?? 'unknown',
            signature: result?.signature ?? null,
            requestedAmount: signal.amount,
            executedAmount: null,
            requestedPrice: signal.price,
            executedPrice: null,
            fees: result?.fees ?? null,
            timestamp: new Date().toISOString(),
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_EXECUTION_FAILED', {
            mint: signal.tokenMint,
            executionStatus: 'FAILED',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }

        // 'pending' and 'expired' are explicitly NOT failures we can forget:
        // a pending transaction may still land. Emit so the operator can
        // reconcile rather than assuming the capital was never committed.
        if (isUnresolved(result)) {
          EventEmitter.prototype.emit.call(this, 'unreconciled', {
            kind: 'entry',
            mint: signal.tokenMint,
            signature: result?.signature,
            status: result?.status,
          });
        }
        return null;
      }

      if (
        result.filledInputAmount !== undefined &&
        (!isPositiveDecimal(result.filledInputAmount) ||
          parseAmount(result.filledInputAmount).greaterThan(parseAmount(signal.amount).times('1.000000001')))
      ) {
        throw new Error(
          `Invalid confirmed entry fill amount: ${result.filledInputAmount}`,
        );
      }
      if (
        result.filledOutputAmount !== undefined &&
        !isPositiveDecimal(result.filledOutputAmount)
      ) {
        throw new Error(
          `Invalid confirmed entry output amount: ${result.filledOutputAmount}`,
        );
      }

      const entryTx = result.signature;
      const entryFees = String(result.fees ?? 0);

      // Prefer the amounts the chain actually executed. Fall back to the
      // quote only when the venue cannot report fills, and say so loudly —
      // silent substitution is how quote-based P&L drift creeps back in.
      let quantity: DecimalValue;
      let actualPrice: DecimalValue;

      if (
        typeof result.filledOutputAmount === 'string' &&
        isPositiveDecimal(result.filledOutputAmount) &&
        typeof result.filledInputAmount === 'string' &&
        isPositiveDecimal(result.filledInputAmount)
      ) {
        quantity = result.filledOutputAmount;
        actualPrice = decimalString(parseAmount(result.filledInputAmount).div(parseAmount(result.filledOutputAmount)));
      } else {
        this.logger.warn('ENTRY_FILL_AMOUNTS_UNAVAILABLE', {
          mint: signal.tokenMint,
          signature: entryTx,
          note: 'falling back to quote pricing; P&L for this position is an estimate',
        });
        actualPrice = quotedPrice;
        quantity = decimalString(parseAmount(signal.amount).div(parseAmount(actualPrice)));
      }

      if (!isPositiveDecimal(actualPrice)) {
        throw new Error(`Invalid entry price: ${actualPrice}`);
      }
      if (!isPositiveDecimal(quantity)) {
        throw new Error(`Invalid entry quantity: ${quantity}`);
      }

      this.logger.info('ENTRY_CONFIRMED', {
        mint: signal.tokenMint,
        signature: entryTx,
        price: actualPrice,
        quantity,
        fees: entryFees,
      });

      // Record the successful execution in research dataset
      try {
        this.researchRecorder.recordExecution({
          tokenMint: signal.tokenMint,
          mint: signal.tokenMint,
          executionStatus: 'CONFIRMED',
          signature: entryTx,
          requestedAmount: signal.amount,
          executedAmount: quantity,
          requestedPrice: signal.price,
          executedPrice: actualPrice,
          slippageBps: Number(parseAmount(actualPrice).minus(parseAmount(signal.price)).div(parseAmount(signal.price)).times(10000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)),
          slippagePercent: pctChange(signal.price, actualPrice),
          fees: entryFees,
          quotedPrice,
          timestamp: new Date().toISOString(),
        });
      } catch (recordError) {
        this.logger.warn('RESEARCH_RECORD_EXECUTION_FAILED', {
          mint: signal.tokenMint,
          executionStatus: 'CONFIRMED',
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }

      // Track qualification at entry time
      const now = Date.now();
      const tracking = this.lifecycleTracking.get(signal.tokenMint);
      if (tracking) {
        tracking.qualificationTime = now;
        tracking.executionTime = now;
        tracking.executionPrice = actualPrice;
        // Add initial fill price to history
        if (!tracking.priceHistory.some((p) => Math.abs(p.timestamp - now) < 10)) {
          tracking.priceHistory.push({ timestamp: now, price: actualPrice });
        }
      }

      const position = this.positionManager.openPosition(
        signal.tokenMint,
        signal.price,
        quantity,
        entryTx,
        actualPrice,
        entryFees,
        signal
        .entryLiquidity,
      );

      // Link position to its lifecycle tracking for later reference
      if (tracking) {
        (position as any).__researchPositionId = signal.tokenMint;
      }

      this.emit('entry', position);
      return position;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', 'ENTRY_ERROR', {
        mint: signal.tokenMint,
        error: msg,
      });
      this.emit('error', error);
      return null;
    } finally {
      this.entryInFlight = false;
    }
  }

  /**
   * Pick the most urgent triggered exit.
   *
   * Ordering matters: a stop-loss must win over a take-profit when both
   * fire on the same tick, or a position that gapped through the stop
   * would be exited on the take-profit path and re-gated by the net-P&L
   * check instead of being closed.
   */
  private highestPriorityExit(
    conditions: ExitCondition[],
  ): ExitCondition | undefined {
    const priority: Record<string, number> = {
      emergency: 0,
      stop_loss: 1,
      trailing_stop: 2,
      time_exit: 3,
      take_profit: 4,
    };

    return [...conditions].sort(
      (a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99),
    )[0];
  }

  async monitorPositions(): Promise<PositionUpdate[]> {
    const openPositions = this.positionManager.getOpenPositions();
    const updates: PositionUpdate[] = [];
    const now = Date.now();

    // Refresh every price concurrently. Sequential per-position RPC meant
    // total loop time scaled with the number of open positions, so with a
    // slow endpoint the last position's stop-loss was evaluated many
    // seconds after the first one's.
    const priced = await Promise.all(
      openPositions.map(async (position) => {
        if (position.status === 'exiting') {
          return { position, price: null as DecimalValue | null, error: null as unknown };
        }
        try {
          if (
            this.executionEngine &&
            typeof this.executionEngine.getPrice === 'function'
          ) {
            const rawPrice = await this.executionEngine.getPrice(position.tokenMint);
            const price = typeof rawPrice === 'string' ? rawPrice : String(rawPrice);
            return { position, price, error: null as unknown };
          }
          return { position, price: null as DecimalValue | null, error: null as unknown };
        } catch (error) {
          return { position, price: null as DecimalValue | null, error };
        }
      }),
    );

    for (const { position, price, error } of priced) {
      if (position.status === 'exiting') continue;

      try {
        if (error) {
          // A thrown getPrice is the MOST likely way the feed dies, so it
          // must fall through to the staleness check below rather than
          // aborting this position's evaluation. Throwing here (the obvious
          // shape) would mean an RPC outage silently skipped the very
          // force-exit the outage is supposed to trigger.
          this.logger.warn('PRICE_FETCH_FAILED', {
            positionId: position.id,
            tokenMint: position.tokenMint,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if (price === null || !isPositiveDecimal(price)) {
          // No fresh price this tick. Fall back to the last known one ONLY
          // while it is still within tolerance. Beyond that, refusing to
          // act on a frozen price is the whole point: a feed that dies and
          // keeps serving its last value silently disables every stop-loss.
          const stale = this.positionManager.isPriceStale(
            position.id,
            this.config.maxPriceAgeMs,
            now,
          );

          if (!stale) {
            // Still within tolerance: evaluate exit conditions against the
            // last known price. Skipping evaluation entirely (the original
            // shape of this fix) meant a transient RPC blip disabled the
            // stop-loss for that tick — trading one silent failure for
            // another.
            //
            // `updatePosition` is deliberately NOT called: it would advance
            // `priceAsOf`, so a permanently dead feed would look forever
            // fresh and the staleness force-exit below would never fire.
            const conditions = this.positionManager.evaluateExitConditions(
              position.id,
            );

            updates.push({
              positionId: position.id,
              currentPrice: position.currentPrice,
              unrealizedPnl: position.unrealizedPnl,
              exitConditions: conditions,
            });

            const triggered = conditions.filter((c) => c.triggered);
            if (triggered.length > 0) {
              const top = this.highestPriorityExit(triggered);
              if (top) {
                // Record exit decision for research
                if (
                  this.researchRecorder
                ) {
                  try {
                    // Get current liquidity if available (this would need to be implemented based on available data sources)
                    const currentLiquidity = null; // Placeholder - would need to be replaced with actual current liquidity measurement

                    this.researchRecorder.recordDecision({
                      recordId: `exit-decision:${position.id}:${now}`,
                      tokenMint: position.tokenMint,
                      mint: position.tokenMint,
                      positionId: position.id,
                      decision: 'EXIT',
                      reason: `Exit triggered by ${top.type}`,
                      // Context at decision time
                      priceAtDecision: position.currentPrice,
                      liquidityAtDecision: currentLiquidity,
                      volumeAtDecision: null, // Would need actual volume data source
                      holderCountAtDecision: null, // Would need actual holder data source
                      // Comprehensive scoring - set to null when not measured
                      momentumScore: null,
                      volumeScore: null,
                      liquidityScore: null,
                      trendScore: null,
                      flowScore: null,
                      executionScore: null,
                      overallScore: null,
                      // Risk breakdown - set to null when not measured
                      riskScore: null,
                      riskComponents: {
                        liquidityRisk: null,
                        volumeRisk: null,
                        momentumRisk: null,
                        holderRisk: null,
                        volatilityRisk: null,
                        executionRisk: null,
                      },
                      // Exit-specific data
                      exitReason: top.type,
                      stopLossThreshold: position.stopLoss,
                      takeProfitThreshold: position.takeProfit,
                      trailingStopThreshold: position.trailingStop,
                      maxHoldThresholdMs: this.config.maxHoldSeconds * 1000,
                      // Configuration snapshot
                      config: {
                        dryRun: process.env['DRY_RUN'] === 'true',
                        tradingEnabled: process.env['TRADING_ENABLED'] === 'true',
                        maxHoldSeconds: this.config.maxHoldSeconds,
                        stopLossPercent: this.config.stopLossPercent,
                        takeProfitPercent: this.config.takeProfitPercent,
                        trailingStopPercent: this.config.trailingStopPercent,
                        maxLiquidityParticipationBps: this.config.maxLiquidityParticipationBps,
                        minRiskScore: this.config.minRiskScore,
                        maxQuoteAgeMs: this.config.maxQuoteAgeMs,
                        maxSellPriceImpactPercent: this.config.maxSellPriceImpactPercent,
                        maxEntryPriceImpactBps: Number(process.env['MAX_ENTRY_PRICE_IMPACT_BPS'] ?? '750'),
                      }
                    });
                  } catch (exitDecisionError) {
                    this.logger.warn('RESEARCH_RECORD_EXIT_DECISION_FAILED', {
                      positionId: position.id,
                      tokenMint: position.tokenMint,
                      error: exitDecisionError instanceof Error ? exitDecisionError.message : String(exitDecisionError),
                    });
                  }
                }

                await this.executeExit(position.id, top.type);
              }
            }
            continue;
          }

          {
            // Back off between attempts. Whatever made the price stale is
            // usually also making the sell quote fail, so an unthrottled
            // retry here would hammer a degraded endpoint four times a
            // second and make recovery less likely, not more.
            if (
              position.staleExitDeferredUntil !== null &&
              now < position.staleExitDeferredUntil
            ) {
              continue;
            }

            this.logger.error('PRICE_STALE', {
              positionId: position.id,
              tokenMint: position.tokenMint,
              ageMs: now - position.priceAsOf,
              maxPriceAgeMs: this.config.maxPriceAgeMs,
            });
            this.emit('stale_price', {
              positionId: position.id,
              tokenMint: position.tokenMint,
              ageMs: now - position.priceAsOf,
            });

            // Exit on the last actionable information rather than sitting
            // blind in a position with no working risk control.
            const closed = await this.executeExit(position.id, 'stale_price');

            if (!closed) {
              this.positionManager.deferStaleExit(
                position.id,
                Date.now() + this.config.exitRetryDelayMs * this.config.exitRetryMaxAttempts,
              );
            }
          }
          continue;
        }

        const update = this.positionManager.updatePosition(position.id, price);
          updates.push(update);

          // Track price in research lifecycle for this position
          const tracking = this.lifecycleTracking.get(position.tokenMint);
          if (tracking && price) {
            // Add to price history (avoid duplicates within 100ms)
            const recentPrice = tracking.priceHistory[tracking.priceHistory.length - 1];
            if (!recentPrice || Math.abs(recentPrice.timestamp - now) >= 100) {
              tracking.priceHistory.push({ timestamp: now, price });
            }
          }

          // Record position observation for research
          if (
            process.env['RESEARCH_RECORD_SAMPLES'] === 'true' &&
            this.researchRecorder &&
            position.tokenMint
          ) {
            try {
              // Get current liquidity if available (this would need to be implemented based on available data sources)
              const currentLiquidity = null; // Placeholder - would need to be replaced with actual current liquidity measurement

              this.researchRecorder.recordObservation({
                event: 'POSITION_OBSERVATION',
                tokenMint: position.tokenMint,
                mint: position.tokenMint,
                positionId: position.id,
                timestamp: now,
                // Position state at observation time
                entryPrice: position.actualEntryPrice,
                currentPrice: price,
                peakPrice: position.peakPrice,
                troughPrice: position.troughPrice,
                unrealizedPnl: position.unrealizedPnl,
                unrealizedPnlPercent: parseAmount(position.entryNotional).greaterThan(0)
                  ? Number(
                      parseAmount(position.unrealizedPnl)
                        .div(parseAmount(position.entryNotional))
                        .times(100)
                        .toFixed(4),
                    )
                  : null,
                elapsedTimeMs: now - position.entryTime.getTime(),
                // Excursion metrics
                mfePct: position.mfePct,
                maePct: position.maePct,
                // Liquidity - record both entry and current liquidity when available
                entryLiquidity: position.entryLiquidity,
                currentLiquidity: currentLiquidity,
                // Thresholds
                stopLossThreshold: position.stopLoss,
                takeProfitThreshold: position.takeProfit,
                trailingStopThreshold: position.trailingStop,
                // Config snapshot
                config: {
                  dryRun: process.env['DRY_RUN'] === 'true',
                  tradingEnabled: process.env['TRADING_ENABLED'] === 'true',
                  maxHoldSeconds: this.config.maxHoldSeconds,
                  stopLossPercent: this.config.stopLossPercent,
                  takeProfitPercent: this.config.takeProfitPercent,
                  trailingStopPercent: this.config.trailingStopPercent,
                  maxLiquidityParticipationBps: this.config.maxLiquidityParticipationBps,
                  minRiskScore: this.config.minRiskScore,
                  maxQuoteAgeMs: this.config.maxQuoteAgeMs,
                  maxSellPriceImpactPercent: this.config.maxSellPriceImpactPercent,
                  maxEntryPriceImpactBps: Number(process.env['MAX_ENTRY_PRICE_IMPACT_BPS'] ?? '750'),
                }
              });
            } catch (obsError) {
              // Research recording errors must never interrupt position monitoring
              this.logger.warn('RESEARCH_RECORD_OBSERVATION_FAILED', {
                positionId: position.id,
                tokenMint: position.tokenMint,
                error: obsError instanceof Error ? obsError.message : String(obsError),
              });
            }
          }

          // Momentum-based exit confirmation: sample on a cadence and require
          // consecutive confirmatory samples before executing a momentum exit.
          try {
            const momentumConfirmed = await this.checkMomentumConfirmation(position);
            if (momentumConfirmed) {
              this.log('info', 'EXIT_MOMENTUM_CONFIRMED', { positionId: position.id });
              await this.executeExit(position.id, 'momentum_volume_reversal');
              continue;
            }
          } catch (err) {
            // Sampling failures are non-fatal; fall through to normal checks.
            this.logger.warn('MOMENTUM_SAMPLE_FAILED', { positionId: position.id, error: err instanceof Error ? err.message : String(err) });
          }

          const triggeredConditions = update.exitConditions.filter((c) => c.triggered);
        if (triggeredConditions.length === 0) continue;

        const topExit = this.highestPriorityExit(triggeredConditions);
        if (!topExit) continue;

        // A take-profit that was skipped on net-of-fee P&L would otherwise
        // re-quote on every 250 ms tick forever, burning RPC quota and
        // rate-limiting the calls that actually matter.
        if (
          topExit.type === 'take_profit' &&
          position.takeProfitDeferredUntil !== null
        ) {
          if (now < position.takeProfitDeferredUntil) {
            continue;
          }

          // Deferral expired. Clear stale state so the position is
          // immediately eligible for normal TP evaluation.
          position.takeProfitDeferredUntil = null;
        }

        // Record exit decision for research
        if (
          this.researchRecorder
        ) {
          try {
            // Get current liquidity if available (this would need to be implemented based on available data sources)
            const currentLiquidity = null; // Placeholder - would need to be replaced with actual current liquidity measurement

            this.researchRecorder.recordDecision({
              recordId: `exit-decision:${position.id}:${now}`,
              tokenMint: position.tokenMint,
              mint: position.tokenMint,
              positionId: position.id,
              decision: 'EXIT',
              reason: `Exit triggered by ${topExit.type}`,
              // Context at decision time
              priceAtDecision: price,
              liquidityAtDecision: currentLiquidity,
              volumeAtDecision: null, // Would need actual volume data source
              holderCountAtDecision: null, // Would need actual holder data source
              // Comprehensive scoring - set to null when not measured
              momentumScore: null,
              volumeScore: null,
              liquidityScore: null,
              trendScore: null,
              flowScore: null,
              executionScore: null,
              overallScore: null,
              // Risk breakdown - set to null when not measured
              riskScore: null,
              riskComponents: {
                liquidityRisk: null,
                volumeRisk: null,
                momentumRisk: null,
                holderRisk: null,
                volatilityRisk: null,
                executionRisk: null,
              },
              // Exit-specific data
              exitReason: topExit.type,
              stopLossThreshold: position.stopLoss,
              takeProfitThreshold: position.takeProfit,
              trailingStopThreshold: position.trailingStop,
              maxHoldThresholdMs: this.config.maxHoldSeconds * 1000,
              // Configuration snapshot
              config: {
                dryRun: process.env['DRY_RUN'] === 'true',
                tradingEnabled: process.env['TRADING_ENABLED'] === 'true',
                maxHoldSeconds: this.config.maxHoldSeconds,
                stopLossPercent: this.config.stopLossPercent,
                takeProfitPercent: this.config.takeProfitPercent,
                trailingStopPercent: this.config.trailingStopPercent,
                maxLiquidityParticipationBps: this.config.maxLiquidityParticipationBps,
                minRiskScore: this.config.minRiskScore,
                maxQuoteAgeMs: this.config.maxQuoteAgeMs,
                maxSellPriceImpactPercent: this.config.maxSellPriceImpactPercent,
                maxEntryPriceImpactBps: Number(process.env['MAX_ENTRY_PRICE_IMPACT_BPS'] ?? '750'),
              }
            });
          } catch (exitDecisionError) {
            this.logger.warn('RESEARCH_RECORD_EXIT_DECISION_FAILED', {
              positionId: position.id,
              tokenMint: position.tokenMint,
              error: exitDecisionError instanceof Error ? exitDecisionError.message : String(exitDecisionError),
            });
          }
        }

        await this.executeExit(position.id, topExit.type);
      } catch (err) {
        this.logger.error('MONITOR_ERROR', {
          positionId: position.id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.emit('error', err);
      }
    }

    return updates;
  }

  async executeExit(
    positionId: string,
    reason: string,
  ): Promise<Position | null> {
    if (this.exitingPositions.has(positionId)) {
      this.log('info', 'EXIT_DUPLICATE_BLOCKED', { positionId, reason });
      return null;
    }

    const position = this.positionManager.getPosition(positionId);
    if (!position || position.status === 'closed') return null;

    this.exitingPositions.add(positionId);
    this.positionManager.markExiting(positionId);

    this.log('info', 'EXIT_STATE_CHANGE', {
      positionId,
      from: 'OPEN',
      to: 'EXIT_PENDING',
      reason,
      at: Date.now(),
    });

    // Captured BEFORE any quoting or retry, so the eventual fill can be
    // compared against the price and threshold that actually caused the exit.
    // Reading these off `position` after the fill would compare the fill to
    // itself — `closePosition` overwrites `currentPrice` with the exit price.
    const trigger: ExitTrigger = {
      at: Date.now(),
      price: position.currentPrice,
      threshold: thresholdForReason(position, reason),
    };

    this.log('info', 'EXIT_SIGNAL', {
      positionId,
      tokenMint: position.tokenMint,
      reason,
      entryPrice: position.actualEntryPrice,
      currentPrice: position.currentPrice,
      triggerThreshold: trigger.threshold,
    });

    try {
      return await this.attemptExit(position, reason, trigger);
    } finally {
      this.exitingPositions.delete(positionId);
    }
  }

  private async attemptExit(
    position: Position,
    reason: string,
    trigger: ExitTrigger,
  ): Promise<Position | null> {
    const maxAttempts = this.config.exitRetryMaxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const sellQuote = await this.getFreshSellQuote(position);
        if (!sellQuote) {
          this.positionManager.recordExitAttempt(
            position.id, 'Could not obtain sell quote',
          );
          this.log('warn', 'EXIT_QUOTE_FAILED', {
            positionId: position.id, attempt,
          });
          if (attempt < maxAttempts) {
            await this.sleep(this.config.exitRetryDelayMs);
            continue;
          }
          this.releasePosition(position.id);
          return null;
        }

        const netPnl = this.calculateNetPnl(position, sellQuote);

        this.log('info', 'EXIT_QUOTE', {
          positionId: position.id,
          sellQuotePrice: sellQuote.pricePerToken,
          grossProceeds: netPnl.grossProceeds,
          netProceeds: netPnl.netProceeds,
          netPnlPercent: Number(parseAmount(netPnl.netPnlPercent).toFixed(2)),
          priceImpactPercent: sellQuote.priceImpactPct,
          quoteAgeMs: netPnl.quoteAgeMs,
          attempt,
        });

        this.log('info', 'EXIT_STATE_CHANGE', {
          positionId: position.id,
          from: 'EXIT_PENDING',
          to: 'EXIT_QUOTED',
          quotePrice: sellQuote.pricePerToken,
          at: Date.now(),
        });

        if (netPnl.isStale) {
          this.positionManager.recordExitAttempt(
            position.id, 'Quote stale', sellQuote.pricePerToken,
          );
          if (attempt < maxAttempts) {
            await this.sleep(this.config.exitRetryDelayMs);
            continue;
          }
          this.releasePosition(position.id);
          return null;
        }

        // Risk-driven exits are not optional, so they are not blocked by the
        // price-impact ceiling. `stale_price` belongs in this set: it fires
        // precisely because we can no longer see the market, and refusing to
        // exit on impact grounds would leave the position open with no
        // working stop — the exact state the check exists to prevent.
        const isEmergencyOrStop = reason.startsWith('emergency') ||
          reason === 'stop_loss' || reason === 'trailing_stop' ||
          reason === 'time_exit' || reason === 'stale_price';

        if (netPnl.excessivePriceImpact && !isEmergencyOrStop) {
          this.log('warn', 'EXIT_EXCESSIVE_PRICE_IMPACT', {
            positionId: position.id,
            priceImpactPercent: sellQuote.priceImpactPct,
            maxPercent: this.config.maxSellPriceImpactPercent,
          });
          this.positionManager.recordExitAttempt(
            position.id,
            `Price impact ${parseAmount(sellQuote.priceImpactPct).toFixed(1)}% exceeds max`,
            sellQuote.pricePerToken,
          );
          if (attempt < maxAttempts) {
            await this.sleep(this.config.exitRetryDelayMs);
            continue;
          }
          this.releasePosition(position.id);
          return null;
        }

        // TP gate: require NET executable P&L to meet threshold
        if (reason === 'take_profit') {
          if (parseAmount(netPnl.netPnlPercent).lessThan(this.config.takeProfitPercent)) {
            this.log('info', 'EXIT_DECISION', {
              positionId: position.id,
              decision: 'SKIP_TP_NOT_MET_NET',
              chartPnlPercent: Number(parseAmount(position.currentPrice).minus(parseAmount(position.actualEntryPrice)).div(parseAmount(position.actualEntryPrice)).times(100).toFixed(2)),
              netPnlPercent: Number(parseAmount(netPnl.netPnlPercent).toFixed(2)),
              requiredPercent: this.config.takeProfitPercent,
            });
            // Back off before re-evaluating. The price-based TP trigger will
            // keep firing every tick while fees keep net P&L below target;
            // without this the engine re-quotes indefinitely.
            this.positionManager.deferTakeProfit(
              position.id,
              Date.now() + this.config.takeProfitRetryDelayMs,
            );
            this.releasePosition(position.id);
            return null;
          }
        }

        this.log('info', 'EXIT_ATTEMPT', {
          positionId: position.id,
          reason,
          attempt,
          netPnlPercent: Number(parseAmount(netPnl.netPnlPercent).toFixed(2)),
        });

        const result = await this.executeSell(position, sellQuote);

        this.log('info', 'EXIT_STATE_CHANGE', {
          positionId: position.id,
          from: 'EXIT_QUOTED',
          to: 'EXIT_SUBMITTED',
          signature: result?.signature ?? null,
          at: Date.now(),
        });

        if (!isFilled(result)) {
          const err = result?.error ?? `Sell not filled (${result?.status ?? 'no_result'})`;
          this.positionManager.recordExitAttempt(
            position.id, err, sellQuote.pricePerToken,
          );
          this.log('warn', 'EXIT_NOT_FILLED', {
            positionId: position.id,
            attempt,
            status: result?.status ?? 'no_result',
            error: err,
          });

          // A pending/expired sell may still land. Retrying it blindly can
          // sell the same tokens twice; surface it for reconciliation and
          // stop rather than looping.
          if (isUnresolved(result)) {
            this.emit('unreconciled', {
              kind: 'exit',
              positionId: position.id,
              mint: position.tokenMint,
              signature: result?.signature,
              status: result?.status,
            });
            this.releasePosition(position.id);
            return null;
          }

          if (attempt < maxAttempts) {
            await this.sleep(this.config.exitRetryDelayMs);
            continue;
          }

          this.log('error', 'EXIT_ALL_RETRIES_EXHAUSTED', {
            positionId: position.id,
            totalAttempts: maxAttempts,
            tokenMint: position.tokenMint,
          });
          this.releasePosition(position.id);
          this.emit('error', new Error(
            `CRITICAL: All ${maxAttempts} exit attempts failed for ${position.tokenMint}`,
          ));
          return null;
        }

        const exitFees = result.fees ?? '0';

        // Book the close from the ACTUAL fill. Falling back to the quote is
        // permitted only when the venue reports no fill amounts, and is
        // logged as an estimate so the degradation is visible in the audit
        // trail rather than being indistinguishable from a real fill.
        const hasFillAmounts =
          typeof result.filledInputAmount === 'string' &&
          isPositiveDecimal(result.filledInputAmount) &&
          parseAmount(result.filledInputAmount).lessThanOrEqualTo(parseAmount(position.quantity).times('1.000000001')) &&
          typeof result.filledOutputAmount === 'string' &&
          isPositiveDecimal(result.filledOutputAmount);

        if (
          result.filledInputAmount !== undefined &&
          (!isPositiveDecimal(result.filledInputAmount) ||
            parseAmount(result.filledInputAmount).greaterThan(parseAmount(position.quantity).times('1.000000001')))
        ) {
          throw new Error(
            `Invalid confirmed exit input amount: ${result.filledInputAmount}`,
          );
        }
        if (
          result.filledOutputAmount !== undefined &&
          !isPositiveDecimal(result.filledOutputAmount)
        ) {
          throw new Error(
            `Invalid confirmed exit output amount: ${result.filledOutputAmount}`,
          );
        }

        if (!hasFillAmounts) {
          this.log('warn', 'EXIT_FILL_AMOUNTS_UNAVAILABLE', {
            positionId: position.id,
            signature: result.signature,
            note: 'realised P&L for this exit is estimated from the quote',
          });
        }

        const soldQuantity = hasFillAmounts
          ? (result.filledInputAmount as string)
          : position.quantity;
        const proceeds = hasFillAmounts
          ? (result.filledOutputAmount as string)
          : sellQuote.outputAmount;

        const closed = this.positionManager.closePosition(
          position.id,
          {
            soldQuantity,
            proceeds,
            exitFees,
            exitTx: result.signature,
          },
          reason,
        );

        const partial = closed.status !== 'closed';

        /*
         * C5 — exit slippage instrumentation.
         *
         * The whole point is to make the gap between "the level that fired"
         * and "the price we got" measurable per trade, rather than inferring
         * it from aggregate statistics after the fact.
         *
         * Three separate gaps, deliberately not collapsed into one number:
         *   trigger -> quote : how much the market moved while we decided
         *   quote   -> fill  : execution slippage against the quote we saw
         *   trigger -> fill  : the total, which is what the P&L reflects
         *
         * `modeledImpactPercent` is the venue's own price-impact estimate.
         * Comparing it against `realizedImpactPercent` is what tells us
         * whether any future pre-trade impact model can be trusted.
         */
        const effectiveExitPrice = decimalString(parseAmount(proceeds).div(parseAmount(soldQuantity)));
        const quoteToFill = pctChange(sellQuote.pricePerToken, effectiveExitPrice);
        const slippage = {
          triggerPrice: trigger.price,
          triggerThreshold: trigger.threshold,
          quotedExitPrice: sellQuote.pricePerToken,
          effectiveExitPrice,
          triggerToQuotePercent: pctChange(trigger.price, sellQuote.pricePerToken),
          quoteToFillPercent: quoteToFill,
          triggerToFillPercent: pctChange(trigger.price, effectiveExitPrice),
          thresholdToFillPercent: pctChange(trigger.threshold, effectiveExitPrice),
          modeledImpactPercent: sellQuote.priceImpactPct,
          // Negated so it reads on the same sign convention as the venue's
          // `priceImpactPct`: a positive number means the fill was worse than
          // the quote. `-null` would be -0, which is why this is explicit.
          realizedImpactPercent:
            quoteToFill === null ? null : Number(new Decimal(quoteToFill).negated().toFixed(4)),
          triggerToFillMs: Date.now() - trigger.at,
          attempts: attempt,
          entryLiquidity: position.entryLiquidity,
          soldQuantity,
        };

        this.log('info', 'EXIT_SLIPPAGE', {
          positionId: position.id,
          tokenMint: position.tokenMint,
          reason,
          ...slippage,
        });

        this.log('info', 'EXIT_STATE_CHANGE', {
          positionId: position.id,
          from: 'EXIT_SUBMITTED',
          to: partial ? 'EXIT_PARTIAL_FILL' : 'EXIT_CONFIRMED',
          signature: result.signature,
          at: Date.now(),
        });

        this.log('info', partial ? 'EXIT_PARTIAL_FILL' : 'EXIT_CONFIRMED', {
          ...slippage,
          positionId: position.id,
          tokenMint: position.tokenMint,
          reason,
          signature: result.signature,
          entryPrice: position.actualEntryPrice,
          proceeds,
          fillAmountsReported: hasFillAmounts,
          residualQuantity: partial ? closed.quantity : 0,
          grossPnl: closed.grossPnl,
          netPnl: closed.netPnl,
          netPnlPercent: Number(parseAmount(closed.netPnlPercent).toFixed(2)),
          totalFees: closed.fees,
        });

        // Record the exit execution in research dataset
        try {
          // Get current liquidity if available (this would need to be implemented based on available data sources)
          const currentLiquidity = null; // Placeholder - would need to be replaced with actual current liquidity measurement

          this.researchRecorder.recordExecution({
            tokenMint: position.tokenMint,
            mint: position.tokenMint,
            positionId: position.id,
            executionStatus: partial ? 'PARTIAL_FILL' : 'CONFIRMED',
            reason,
            signature: result.signature,
            requestedAmount: position.quantity,
            executedAmount: soldQuantity,
            requestedPrice: sellQuote.pricePerToken,
            executedPrice: effectiveExitPrice,
            slippageBps: slippage.quoteToFillPercent !== null
              ? Number(new Decimal(slippage.quoteToFillPercent).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0))
              : null,
            slippagePercent: slippage.quoteToFillPercent,
            fees: exitFees,
            proceeds,
            pnl: closed.netPnl,
            pnlPercent: closed.netPnlPercent,
            holdDurationMs: Date.now() - position.entryTime.getTime(),
            // Additional exit research fields
            entryPrice: position.actualEntryPrice,
            exitPrice: effectiveExitPrice,
            peakPrice: position.peakPrice,
            troughPrice: position.troughPrice,
            unrealizedPnlPercent: parseAmount(position.entryNotional).greaterThan(0)
              ? Number(parseAmount(position.unrealizedPnl).div(parseAmount(position.entryNotional)).times(100).toFixed(12))
              : null,
            drawdownPercent: position.peakPrice && position.troughPrice
                ? Number(parseAmount(position.peakPrice).minus(parseAmount(position.troughPrice)).div(parseAmount(position.peakPrice)).times(100).toFixed(12))
                : null,
            mfePct: position.mfePct,
            maePct: position.maePct,
            currentLiquidity: currentLiquidity,
            // Trigger state
            exitTriggerReason: reason,
            exitTriggerPrice: trigger.price, // Use the actual trigger price from ExitTrigger
            exitTriggerThreshold: trigger.threshold, // From the ExitTrigger captured earlier
            // Thresholds
            stopLossThreshold: position.stopLoss,
            takeProfitThreshold: position.takeProfit,
            trailingStopThreshold: position.trailingStop,
            maxHoldThresholdMs: this.config.maxHoldSeconds * 1000,
            // Configuration snapshot
            config: {
              dryRun: process.env['DRY_RUN'] === 'true',
              tradingEnabled: process.env['TRADING_ENABLED'] === 'true',
              maxHoldSeconds: this.config.maxHoldSeconds,
              stopLossPercent: this.config.stopLossPercent,
              takeProfitPercent: this.config.takeProfitPercent,
              trailingStopPercent: this.config.trailingStopPercent,
              maxLiquidityParticipationBps: this.config.maxLiquidityParticipationBps,
              minRiskScore: this.config.minRiskScore,
              maxQuoteAgeMs: this.config.maxQuoteAgeMs,
              maxSellPriceImpactPercent: this.config.maxSellPriceImpactPercent,
              maxEntryPriceImpactBps: Number(process.env['MAX_ENTRY_PRICE_IMPACT_BPS'] ?? '750'),
            },
            timestamp: new Date().toISOString(),
          });
        } catch (recordError) {
          this.logger.warn('RESEARCH_RECORD_EXECUTION_FAILED', {
            positionId: position.id,
            executionStatus: partial ? 'PARTIAL_FILL' : 'CONFIRMED',
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }

        if (partial) {
          // The remainder is still live and still needs monitoring; do not
          // emit 'exit' (which records a completed trade to the breaker).
          this.releasePosition(position.id);
          this.emit('partial_exit', closed);
          return null;
        }

        // Record research data before final emit
        this.recordPositionLifecycle(position, closed, reason);

        this.emit('exit', closed);
        return closed;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.positionManager.recordExitAttempt(position.id, msg);
        this.log('error', 'EXIT_ERROR', {
          positionId: position.id, attempt, error: msg,
        });
        if (attempt < maxAttempts) {
          await this.sleep(this.config.exitRetryDelayMs);
          continue;
        }
        this.releasePosition(position.id);
        this.emit('error', error);
        return null;
      }
    }

    this.releasePosition(position.id);
    return null;
  }

  private async getFreshSellQuote(
    position: Position,
  ): Promise<SellQuote | null> {
    if (
      !this.executionEngine ||
      typeof this.executionEngine.quoteSell !== 'function'
    ) {
      return null;
    }

    try {
      const quote = await this.executionEngine.quoteSell(
        position.tokenMint, position.quantity,
      );
      return {
        outputAmount: quote.outputAmount,
        outputRawAmount: quote.outputRawAmount,
        pricePerToken: quote.pricePerToken,
        priceImpactPct: quote.priceImpactPct,
        route: quote.route,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  calculateNetPnl(position: Position, sellQuote: SellQuote): NetPnlResult {
    // grossProceeds = SOL the sell quote says we'll receive (already
    // reflects slippage and price impact baked into the quote).
    const grossProceeds = sellQuote.outputAmount;

    // Sell-side cost estimate.
    //
    // Reusing `position.entryFees` verbatim assumed entry and exit cost the
    // same, which is wrong whenever the venue charges a percentage (pump.fun
    // takes 1% on both legs, so a profitable position pays MORE on the way
    // out than it did on the way in) — and it under-estimated exactly when
    // the position was up, i.e. when the take-profit gate was being applied.
    // Prefer a venue-reported fee, then a proportional estimate, then the
    // entry fee as a last resort.
    const venueFee =
      typeof sellQuote.estimatedFeeSol === 'string'
        && isNonNegativeDecimal(sellQuote.estimatedFeeSol)
        ? sellQuote.estimatedFeeSol
        : null;

    const proportionalFee =
      parseAmount(position.entryNotional).greaterThan(0)
        ? decimalString(parseAmount(position.entryFees).times(parseAmount(grossProceeds).div(parseAmount(position.entryNotional))))
        : position.entryFees;

    const estimatedSellFees =
      venueFee !== null
        ? venueFee
        : decimalString(Decimal.max(parseAmount(proportionalFee), parseAmount(position.entryFees)));

    // Price impact is already reflected in the quote's outputAmount; this is
    // reported for observability only and must NOT be subtracted again.
    const estimatedPriceImpact =
      decimalString(parseAmount(grossProceeds).times(parseAmount(sellQuote.priceImpactPct)).div(100));

    // Net proceeds = what we actually keep after paying sell fees.
    // Entry cost already includes entry fees (entryNotional = price * qty + entryFees).
    // We subtract only sell fees from grossProceeds, not entry fees again.
    const netProceeds = decimalString(parseAmount(grossProceeds).minus(parseAmount(estimatedSellFees)));
    const entryCost = position.entryNotional;
    const netPnl = decimalString(parseAmount(netProceeds).minus(parseAmount(entryCost)));
    const netPnlPercent = parseAmount(entryCost).greaterThan(0)
      ? decimalString(parseAmount(netPnl).div(parseAmount(entryCost)).times(100))
      : '0';
    const quoteAgeMs = Date.now() - sellQuote.timestamp;

    return {
      grossProceeds,
      estimatedSellFees,
      estimatedPriceImpact,
      netProceeds,
      entryCost,
      netPnl,
      netPnlPercent,
      quoteAgeMs,
      isStale: quoteAgeMs > this.config.maxQuoteAgeMs,
      excessivePriceImpact:
        parseAmount(sellQuote.priceImpactPct).greaterThan(this.config.maxSellPriceImpactPercent),
    };
  }

  private async sampleMomentum(position: Position): Promise<{ valid: boolean; buyPressure?: number; sellPressure?: number; netFlowPct?: number }> {
    // Try to use an executionEngine-provided sampler if available.
    try {
      if (this.executionEngine && typeof this.executionEngine.sampleMomentum === 'function') {
        const s = await this.executionEngine.sampleMomentum(position.tokenMint);
        return { valid: true, buyPressure: s.buyPressure, sellPressure: s.sellPressure, netFlowPct: s.netFlowPct };
      }
    } catch (err) {
      return { valid: false };
    }
    return { valid: false };
  }

  private async checkMomentumConfirmation(position: Position): Promise<boolean> {
    if (this.config.aggressiveExitOnMomentumReversal === false) return false;

    const windowMs = this.config.exitMomentumWindowMs ?? 10_000;
    const sampleInterval = this.config.exitMomentumSampleIntervalMs ?? 1_000;
    const confirmSamples = this.config.exitMomentumConfirmSamples ?? 3;
    const buyThreshold = this.config.exitMomentumBuyPressureThreshold ?? 0.4;
    const sellThreshold = this.config.exitMomentumSellPressureThreshold ?? 0.6;
    const netFlowThreshold = this.config.exitMomentumNetFlowPctThreshold ?? -5;

    const state = this.momentumState.get(position.id) ?? { count: 0, lastSampleTs: 0 };
    const now = Date.now();
    if (now - state.lastSampleTs < sampleInterval) return false;

    const sample = await this.sampleMomentum(position);
    state.lastSampleTs = now;

    if (!sample.valid) {
      // Cannot evaluate; do not increment.
      this.momentumState.set(position.id, state);
      return false;
    }

    const buyPressure = typeof sample.buyPressure === 'number' ? sample.buyPressure : null;
    const sellPressure = typeof sample.sellPressure === 'number' ? sample.sellPressure : null;
    const netFlow = typeof sample.netFlowPct === 'number' ? sample.netFlowPct : null;

    // Require both momentum and volume-side deterioration. Missing evidence
    // cannot confirm a reversal, and one noisy metric must not liquidate.
    const momentumReversed =
      (buyPressure !== null && buyPressure < buyThreshold) ||
      (netFlow !== null && netFlow < netFlowThreshold);
    const volumeReversed =
      sellPressure !== null && sellPressure > sellThreshold;
    const deterioration = momentumReversed && volumeReversed;

    if (deterioration) {
      state.count = (state.count ?? 0) + 1;
    } else {
      state.count = 0;
    }

    this.momentumState.set(position.id, state);

    return state.count >= confirmSamples;
  }

  /**
   * Execute the sell against the quote the exit decision was made on.
   *
   * This previously re-quoted immediately before sending, so the price the
   * position was closed at (the first quote) was not the price the sell was
   * built from (the second). Passing the decided quote through removes that
   * divergence and the extra RPC round-trip on the latency-critical path.
   */
  private async executeSell(
    position: Position,
    decidedQuote: SellQuote,
  ): Promise<ExecutionResult | null> {
    if (!this.executionEngine) return null;

    if (
      typeof this.executionEngine.executePumpFunSell === 'function' &&
      position.tokenMint.endsWith('pump')
    ) {
      return this.executionEngine.executePumpFunSell(
        position.tokenMint, position.quantity,
      );
    }

    if (typeof this.executionEngine.buildSellTransaction === 'function') {
      const tx = await this.executionEngine.buildSellTransaction({
        inputMint: position.tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        inputAmount: position.quantity,
        outputAmount: decidedQuote.outputAmount,
        pricePerToken: decidedQuote.pricePerToken,
        priceImpactPct: decidedQuote.priceImpactPct,
        slippageBps: 0,
        route: decidedQuote.route,
      });
      return this.executionEngine.signAndSendTransaction(tx);
    }

    return null;
  }

  private releasePosition(positionId: string): void {
    this.positionManager.releaseExiting(positionId);
  }

  /**
   * Exit every open position concurrently.
   *
   * Sequential exits meant the wall-clock cost of an emergency was
   * `positions x attempts x retryDelay` — with 10 positions and the default
   * 3 attempts at 2 s that is up to a minute of exposure while a pool is
   * being drained. Concurrency is bounded so a large book cannot itself
   * rate-limit the RPC endpoint the exits depend on.
   */
  async emergencyExitAll(reason: string, concurrency = 5): Promise<Position[]> {
    this.emit('emergency', reason);
    this.log('error', 'EMERGENCY_EXIT', { reason });

    const openPositions = this.positionManager.getOpenPositions();
    const closed: Position[] = [];
    const queue = [...openPositions];

    const worker = async (): Promise<void> => {
      for (;;) {
        const position = queue.shift();
        if (!position) return;
        try {
          const result = await this.executeExit(
            position.id, `emergency: ${reason}`,
          );
          if (result) closed.push(result);
        } catch (error) {
          // One failed exit must never abort the others.
          this.log('error', 'EMERGENCY_EXIT_POSITION_FAILED', {
            positionId: position.id,
            tokenMint: position.tokenMint,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, worker),
    );

    if (closed.length < openPositions.length) {
      this.log('error', 'EMERGENCY_EXIT_INCOMPLETE', {
        reason,
        requested: openPositions.length,
        closed: closed.length,
        stillOpen: this.positionManager.getOpenPositions().length,
      });
    }

    return closed;
  }

  /**
   * Exit only the positions holding a given mint.
   *
   * Required by the liquidity-alert path: a rug in one token must not force
   * a portfolio-wide liquidation, but it must reliably close THAT token.
   * Previously this method did not exist and the caller duck-typed for it,
   * silently doing nothing when it was absent.
   */
  async emergencyExitToken(tokenMint: string, reason: string): Promise<Position[]> {
    this.log('error', 'TOKEN_EMERGENCY_EXIT', { tokenMint, reason });

    const targets = this.positionManager
      .getOpenPositions()
      .filter((p) => p.tokenMint === tokenMint);

    const closed: Position[] = [];

    const results = await Promise.all(
      targets.map(async (position) => {
        try {
          return await this.executeExit(position.id, `emergency: ${reason}`);
        } catch (error) {
          this.log('error', 'TOKEN_EMERGENCY_EXIT_FAILED', {
            positionId: position.id,
            tokenMint,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );

    for (const result of results) {
      if (result) closed.push(result);
    }

    if (closed.length < targets.length) {
      this.log('error', 'TOKEN_EMERGENCY_EXIT_INCOMPLETE', {
        tokenMint,
        requested: targets.length,
        closed: closed.length,
      });
    }

    return closed;
  }

  /**
   * Start the position monitor.
   *
   * The interval was hardcoded at 250 ms, which meant FOUR price lookups
   * per second per open position — at the 3-position cap that is 12 RPC
   * calls/second doing nothing but re-reading prices, before any exit
   * quoting. On a rate-limited endpoint that starves the calls that
   * actually matter (discovery, and the sell quote during an exit), so the
   * fast loop made exits *less* reliable, not more.
   *
   * Configurable via MONITOR_INTERVAL_MS, defaulting to 1s. Stop-loss
   * latency is bounded by this interval, so it is a genuine tradeoff — but
   * exit execution takes seconds anyway, and sub-second polling buys very
   * little against what it costs in quota.
   */
  start(intervalMs = 1_000): void {
    if (this.running) return;
    this.running = true;

    this.monitorInterval = setInterval(() => {
      // The `monitoring` flag makes ticks non-overlapping: a slow tick is
      // skipped rather than queued, so a degraded RPC cannot build a
      // backlog of concurrent monitor passes.
      if (!this.running || this.monitoring) return;
      this.monitoring = true;
      void this.monitorPositions().finally(() => {
        this.monitoring = false;
      });
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    data: Record<string, unknown>,
  ): void {
    this.logger[level](msg, data);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Record the complete lifecycle of a closed position to the research database.
   * Called when a position is fully closed (not partial exits).
   */
  private recordPositionLifecycle(
    position: Position,
    closedPosition: Position,
    exitReason: string,
  ): void {
    try {
      const tracking = this.lifecycleTracking.get(position.tokenMint);
      if (!tracking) {
        return; // No tracking data for this position
      }

      // Build the lifecycle event record
      const lifecycle: PriceLifecycleEvent = {
        observationTime: tracking.observationTime,
        observationPrice: decimalToNumberForResearch(tracking.observationPrice),
        signalTime: tracking.signalTime ?? tracking.observationTime,
        signalPrice: decimalToNumberForResearch(
          tracking.signalPrice ?? tracking.observationPrice,
        ),
        qualificationTime: tracking.qualificationTime ?? Date.now(),
        qualifiedEntryPrice: decimalToNumberForResearch(position.qualifiedEntryPrice),
      };

      // Only include execution data if available
      if (tracking.executionTime && tracking.executionPrice) {
        lifecycle.executionTime = tracking.executionTime;
        lifecycle.executionPrice = decimalToNumberForResearch(tracking.executionPrice);
      }

      // Record to research database
      this.researchRecorder.recordLifecycle(
        position.tokenMint,
        lifecycle,
        true, // position was opened
        position.id,
        tracking.priceHistory.map(({ timestamp, price }) => ({
          timestamp,
          price: decimalToNumberForResearch(price),
        })),
      );

      // Clean up lifecycle tracking to avoid memory leaks
      this.lifecycleTracking.delete(position.tokenMint);
    } catch (error) {
      // Research recording errors must NEVER interrupt trading
      this.logger.warn('RESEARCH_RECORD_FAILED', {
        positionId: position.id,
        tokenMint: position.tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Fallback logger. Production callers must inject the real one. */
function consoleLogger(): EngineLogger {
  const emit =
    (level: 'info' | 'warn' | 'error') =>
    (msg: string, data?: Record<string, unknown>): void => {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          msg,
          ...(data ?? {}),
        }),
      );
    };

  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
