
import { randomUUID } from 'node:crypto';
import {
  OrderIntent,
  RiskVerdict,
  TimestampSchema,
  BasisPointsSchema,
} from '@mayhem/core-types';
import { RiskConfig, RiskAssessment, RiskCheck, TokenMetadata, PoolInfo, HolderInfo } from './types';
import { RiskContext } from './context.js';
import { TokenSafetyScanner } from './scanner';

interface RiskEngineOptions {
  now?: () => number;
  newVerdictId?: () => string;
}

type LegacyCtor = RiskConfig | { limits: any; now?: () => number; newVerdictId?: () => string };

export class RiskEngine {
  // `config` holds the engine limits object expected by the implementation/tests.
  private config: any;
  private scanner: TokenSafetyScanner;
  private emergencyStopActive: boolean;
  private now: () => number;
  private newVerdictId: () => string;

  constructor(configOrOptions: LegacyCtor, options: RiskEngineOptions = {}) {
    // Backwards-compatible constructor: accept either a plain RiskConfig
    // or an options object `{ limits, now, newVerdictId }` used by tests.
    if (configOrOptions && typeof configOrOptions === 'object' && 'limits' in configOrOptions) {
      this.config = (configOrOptions as any).limits;
      this.now = (configOrOptions as any).now ?? options.now ?? (() => Date.now());
      this.newVerdictId = (configOrOptions as any).newVerdictId ?? options.newVerdictId ?? (() => randomUUID());
      this.emergencyStopActive = this.config.emergencyStop ?? false;
    } else {
      this.config = configOrOptions as any;
      this.now = options.now ?? (() => Date.now());
      this.newVerdictId = options.newVerdictId ?? (() => randomUUID());
      this.emergencyStopActive = this.config.emergencyStop ?? false;
    }

    this.scanner = new TokenSafetyScanner(this.config);
  }

  assessToken(token: TokenMetadata, pool: PoolInfo, holders?: HolderInfo[]): RiskAssessment {
    return this.scanner.scan(token, pool, holders);
  }

  evaluate(order: OrderIntent, ctx: RiskContext): RiskVerdict {
    const breaches: Array<{ rule: string; observed: string; limit: string; message: string }> = [];
    const amountIn = BigInt(order.amountIn);
    const notionalLimit = BigInt(ctx.notionalLamports);
    const positionLamports = BigInt(ctx.portfolio.positionLamports);
    const strategyExposure = BigInt(ctx.portfolio.strategyExposureLamports);
    const globalExposure = BigInt(ctx.portfolio.globalExposureLamports);
    const dailyLoss = BigInt(ctx.portfolio.dailyRealizedLossLamports);
    const peakEquity = BigInt(ctx.portfolio.peakEquityLamports);
    const currentEquity = BigInt(ctx.portfolio.currentEquityLamports);
    const maxNotional = BigInt(this.config.maxNotionalPerOrderLamports ?? 0);
    const maxPosition = BigInt(this.config.maxPositionLamports ?? 0);
    const maxStrategyExposure = BigInt(this.config.maxStrategyExposureLamports ?? 0);
    const maxGlobalExposure = BigInt(this.config.maxGlobalExposureLamports ?? 0);

    const enforcedSlippage = Math.min(order.maxSlippageBps, this.config.maxSlippageBps);
    const concentrationLimit = (peakEquity * BigInt(this.config.maxConcentrationBps)) / 10_000n;
    // participation cap based on venue liquidity (if available)
    const poolLiquidity = ctx.market ? BigInt(ctx.market.poolLiquidityLamports as any) : 0n;
    const liquidityParticipationCap = (poolLiquidity * BigInt(this.config.maxLiquidityParticipationBps)) / 10_000n;
    let approvedAmountIn = amountIn;

    // Clamp downward at every step and never let the running value go
    // negative. A negative intermediate (e.g. exposure already over limit)
    // previously survived to the end and only got zeroed at the very last
    // line, which made the "is there any headroom?" reasoning below depend
    // on ordering rather than on the limits themselves.
    const clamp = (value: bigint, limit: bigint): bigint => {
      const capped = value > limit ? limit : value;
      return capped < 0n ? 0n : capped;
    };
    approvedAmountIn = clamp(approvedAmountIn, maxNotional);
    approvedAmountIn = clamp(approvedAmountIn, notionalLimit);
    approvedAmountIn = clamp(approvedAmountIn, maxPosition - positionLamports);
    approvedAmountIn = clamp(approvedAmountIn, concentrationLimit - positionLamports);
    approvedAmountIn = clamp(approvedAmountIn, maxStrategyExposure - strategyExposure);
    approvedAmountIn = clamp(approvedAmountIn, maxGlobalExposure - globalExposure);
    // apply pool participation cap last (if pool info present)
    if (liquidityParticipationCap > 0n) {
      approvedAmountIn = clamp(approvedAmountIn, liquidityParticipationCap);
    }

    const addBreach = (rule: string, observed: string, limit: string, message: string): void => {
      breaches.push({ rule, observed, limit, message });
    };

    // Respect an engine-level emergency stop (set via `setEmergencyStop`) as well
    // as any externally supplied kill switch in the risk context.
    if (this.emergencyStopActive) {
      addBreach('kill_switch_engaged', 'true', 'false', 'Emergency stop is active');
    }

    if (ctx.killSwitchEngaged) {
      addBreach('kill_switch_engaged', 'true', 'false', 'Kill switch engaged in context');
    }

    if (ctx.portfolio.consecutiveLosses >= (this.config.maxConsecutiveLosses ?? 0)) {
      addBreach('circuit_breaker_consecutive_losses', String(ctx.portfolio.consecutiveLosses), String(this.config.maxConsecutiveLosses ?? 0), 'Consecutive losses exceed configured maximum');
    }

    if (order.expiresAt <= ctx.now) {
      addBreach('intent_expired', String(order.expiresAt), String(ctx.now), 'Intent expired before evaluation');
    }

    if (ctx.quarantinedAgents.includes(order.proposedBy) || ctx.quarantinedStrategies.includes(order.strategyId)) {
      addBreach('agent_quarantined', order.proposedBy, 'allowed', 'Agent or strategy is quarantined');
    }

    if (!ctx.market) {
      addBreach('market_data_unavailable', 'none', 'available', 'No market snapshot available');
    }

    if (ctx.market) {
      if (ctx.market.asOf + this.config.maxMarketDataAgeMs < ctx.now) {
        addBreach('stale_market_data', String(ctx.market.asOf), String(ctx.now - this.config.maxMarketDataAgeMs), 'Market data is too old');
      }

      if (!ctx.market.sellable) {
        addBreach('token_not_sellable', 'false', 'true', 'Token is not demonstrably sellable');
      }

      if (BigInt(ctx.market.poolLiquidityLamports as any) === 0n) {
        addBreach('liquidity_insufficient', String(ctx.market.poolLiquidityLamports), '>=1', 'Pool has no liquidity');
      }

      if (ctx.market.manipulationScore >= this.config.manipulationScoreThreshold) {
        addBreach('manipulation_suspected', String(ctx.market.manipulationScore), String(this.config.manipulationScoreThreshold), 'Manipulation score exceeds threshold');
      }

      if (ctx.market.estimatedSlippageBps > enforcedSlippage) {
        addBreach('max_slippage', String(ctx.market.estimatedSlippageBps), String(enforcedSlippage), 'Estimated slippage exceeds enforced bound');
      }
    }

    // sizing/exposure checks: we compute approvedAmountIn by clamping above.
    // Only surface sizing breaches if there are no other blocking breaches
    // and the final approved size is zero (no headroom).

    if (dailyLoss >= BigInt(this.config.dailyLossLimitLamports)) {
      addBreach('daily_loss_limit', String(dailyLoss), String(this.config.dailyLossLimitLamports), 'Daily loss limit reached or exceeded');
    }

    // Sizing/exposure limits are evaluated UNCONDITIONALLY.
    //
    // Previously these were only checked when `breaches.length === 0`, so an
    // unrelated breach (say, stale market data) masked the fact that the
    // account was also over its global exposure limit. That produced audit
    // records which understated why an order was rejected, and — worse —
    // meant a caller who fixed the market-data problem could be surprised by
    // an exposure breach that had been there all along.
    if (approvedAmountIn <= 0n) {
      const positionHeadroom = maxPosition - positionLamports;
      if (positionHeadroom <= 0n) {
        addBreach('max_position_size', String(positionLamports), String(maxPosition), 'Position is at or above per-order maximum position size');
      }

      const concentrationHeadroom = concentrationLimit - positionLamports;
      if (concentrationHeadroom <= 0n) {
        addBreach('max_concentration', String(positionLamports), String(concentrationLimit), 'Position is at or above concentration limit');
      }

      const strategyHeadroom = maxStrategyExposure - strategyExposure;
      if (strategyHeadroom <= 0n) {
        addBreach('max_strategy_exposure', String(strategyExposure), String(maxStrategyExposure), 'Strategy exposure at or above limit');
      }

      const globalHeadroom = maxGlobalExposure - globalExposure;
      if (globalHeadroom <= 0n) {
        addBreach('max_global_exposure', String(globalExposure), String(maxGlobalExposure), 'Global exposure at or above limit');
      }

      // No specific limit is exhausted, yet nothing can be filled — e.g. the
      // pool participation cap rounds to zero. Never return "approved, size 0".
      if (breaches.length === 0) {
        addBreach('zero_approved_size', '0', '>0', 'No fillable size remains after applying all sizing caps');
      }
    }

    if (peakEquity > 0n && peakEquity - currentEquity > (peakEquity * BigInt(this.config.maxDrawdownBps)) / 10_000n) {
      addBreach('max_drawdown', String(peakEquity - currentEquity), String((peakEquity * BigInt(this.config.maxDrawdownBps)) / 10_000n), 'Drawdown exceeds maximum allowed');
    }

    if (ctx.portfolio.observedExecutionLatencyMs > this.config.maxExecutionLatencyMs) {
      addBreach('circuit_breaker_latency', String(ctx.portfolio.observedExecutionLatencyMs), String(this.config.maxExecutionLatencyMs), 'Execution latency exceeds the configured threshold');
    }

    const approved = breaches.length === 0;
    const finalApprovedAmountIn = approved ? (approvedAmountIn >= 0n ? approvedAmountIn : 0n) : undefined;
    const riskScore = approved
      ? ctx.market?.manipulationScore ?? 0
      : 100;

    return {
      verdictId: this.newVerdictId(),
      correlationId: order.correlationId,
      intentId: order.intentId,
      evaluatedAt: TimestampSchema.parse(this.now()),
      approved,
      breaches: breaches.map((b) => ({ rule: b.rule as any, observed: b.observed, limit: b.limit, message: b.message })),
      approvedAmountIn: finalApprovedAmountIn,
      enforcedMaxSlippageBps: BasisPointsSchema.parse(enforcedSlippage),
      riskScore,
    };
  }

  checkDailyLoss(currentDailyLoss: number): RiskCheck {
    return {
      name: 'daily_loss',
      passed: currentDailyLoss < this.config.maxDailyLossSol,
      value: currentDailyLoss,
      threshold: this.config.maxDailyLossSol,
      message: currentDailyLoss >= this.config.maxDailyLossSol
        ? `Daily loss ${currentDailyLoss} SOL exceeds max ${this.config.maxDailyLossSol} SOL`
        : 'Daily loss within limits',
    };
  }

  checkPositionLimit(openPositions: number, max: number): RiskCheck {
    return {
      name: 'position_limit',
      passed: openPositions < max,
      value: openPositions,
      threshold: max,
      message: openPositions >= max
        ? `Open positions ${openPositions} at max ${max}`
        : 'Position limit ok',
    };
  }

  checkExposure(currentExposure: number): RiskCheck {
    return {
      name: 'exposure',
      passed: currentExposure <= this.config.maxExposureSol,
      value: currentExposure,
      threshold: this.config.maxExposureSol,
      message: currentExposure > this.config.maxExposureSol
        ? `Exposure ${currentExposure} SOL exceeds max ${this.config.maxExposureSol} SOL`
        : 'Exposure within limits',
    };
  }

  checkLiquidity(liquiditySol: number): RiskCheck {
    return {
      name: 'liquidity',
      passed: liquiditySol >= this.config.minLiquiditySol,
      value: liquiditySol,
      threshold: this.config.minLiquiditySol,
      message: liquiditySol < this.config.minLiquiditySol
        ? `Liquidity ${liquiditySol} SOL below min ${this.config.minLiquiditySol} SOL`
        : 'Liquidity sufficient',
    };
  }

  checkSlippage(estimatedSlippage: number, maxSlippage: number): RiskCheck {
    return {
      name: 'slippage',
      passed: estimatedSlippage <= maxSlippage,
      value: estimatedSlippage,
      threshold: maxSlippage,
      message: estimatedSlippage > maxSlippage
        ? `Slippage ${estimatedSlippage}% exceeds max ${maxSlippage}%`
        : 'Slippage acceptable',
    };
  }

  checkWalletBalance(balance: number, tradeSize: number): RiskCheck {
    return {
      name: 'wallet_balance',
      passed: balance >= tradeSize,
      value: balance,
      threshold: tradeSize,
      message: balance < tradeSize
        ? `Balance ${balance} SOL insufficient for trade size ${tradeSize} SOL`
        : 'Balance sufficient',
    };
  }

  checkTokenRisk(assessment: RiskAssessment): RiskCheck {
    const passed = assessment.score >= 50;
    return {
      name: 'token_risk',
      passed,
      value: assessment.score,
      threshold: 50,
      message: passed ? 'Token risk acceptable' : `Token risk score ${assessment.score} too low`,
    };
  }

  checkMaxTradeSize(size: number, max: number): RiskCheck {
    return {
      name: 'max_trade_size',
      passed: size <= max,
      value: size,
      threshold: max,
      message: size > max
        ? `Trade size ${size} SOL exceeds max ${max} SOL`
        : 'Trade size within limits',
    };
  }

  checkCooldown(lastTradeTime: Date): RiskCheck {
    const elapsed = Date.now() - lastTradeTime.getTime();
    return {
      name: 'cooldown',
      passed: elapsed >= this.config.cooldownMs,
      value: elapsed,
      threshold: this.config.cooldownMs,
      message: elapsed < this.config.cooldownMs
        ? `Cooldown active, ${this.config.cooldownMs - elapsed}ms remaining`
        : 'Cooldown elapsed',
    };
  }

  checkEmergencyStop(): RiskCheck {
    return {
      name: 'emergency_stop',
      passed: !this.emergencyStopActive,
      value: this.emergencyStopActive,
      threshold: false,
      message: this.emergencyStopActive ? 'Emergency stop is active' : 'No emergency stop',
    };
  }

  canTrade(checks: RiskCheck[]): boolean {
    return checks.every((c) => c.passed);
  }

  setEmergencyStop(value: boolean): void {
    this.emergencyStopActive = value;
  }

  private calculateRiskScore(checks: RiskCheck[]): number {
    if (checks.length === 0) return 0;
    const passed = checks.filter((c) => c.passed).length;
    return Math.round((passed / checks.length) * 100);
  }
}