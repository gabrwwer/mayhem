import {
  MayhemEngine,
  CandidateManager,
  Candidate,
} from '@mayhem/trading-engine';
import {
  CircuitBreaker,
} from '@mayhem/risk-engine';
import {
  SimulatedExecutionEngine,
  isPumpFunToken,
} from '@mayhem/execution';
import {
  TokenDiscoveryEvent,
  LiquidityAlert,
  PendingLpEvent,
} from '@mayhem/token-monitor';
import { BotConfig } from '@mayhem/config';
import { logger } from './logger';
import {
  evaluateSignal,
  validateThresholds,
  type PriceSample,
  type SignalThresholds,
} from './momentum-signal';

/**
 * Result of the observation window. `confirmed` drives the entry decision; the
 * remaining fields exist to be logged on rejection — without them, tuning the
 * thresholds means guessing which condition failed.
 */
interface MomentumOutcome {
  confirmed: boolean;
  finalPrice: number;
  growthPerMin: number;
  maxDrawdownPct: number;
  buyPressure: number;
  /** Magnitude-weighted buy share. This is the value the gate acts on. */
  flowBuyPressure: number;
  /** Distance below the window peak at the final sample. Gating metric. */
  finalDrawdownPct: number;
  /** Share of sampling intervals with no price movement at all. */
  flatRatio: number;
  netFlowPct: number;
  volatility: number;
  samples: number;
  flatIntervals: number;
  /** Sampling ticks where the quote could not be read. High values invalidate the window. */
  failedReads: number;
  reason: string;
}

function emptyMomentumOutcome(finalPrice: number, reason: string): MomentumOutcome {
  return {
    confirmed: false,
    finalPrice,
    growthPerMin: 0,
    maxDrawdownPct: 0,
    buyPressure: 0,
    flowBuyPressure: 0,
    finalDrawdownPct: 0,
    flatRatio: 0,
    netFlowPct: 0,
    volatility: 0,
    samples: 0,
    flatIntervals: 0,
    failedReads: 0,
    reason,
  };
}

interface EarlyFlowOutcome {
  confirmed: boolean;
  finalPrice: number;
  // Timing
  ageSeconds: number;
  // Core momentum metrics
  buyPressure: number;
  netFlowPct: number;
  priceChangePercent: number;
  drawdownPercent: number;
  flatRatio: number;
  volatility: number;
  // Wallet/transaction metrics
  uniqueBuyers: number;
  uniqueSellers: number;
  buyTransactionCount: number;
  sellTransactionCount: number;
  topBuyerConcentration: number;
  // Execution metrics
  curveDepthSol: number;
  priceImpactBps: number;
  quoteAgeMs: number;
  // Scoring
  opportunityScore: number; // 0-100
  gateViolations: string[]; // Hard gate failures
  // Diagnostics
  samples: number;
  failedReads: number;
  reason: string;
  // Aliases for compatibility with MomentumOutcome shape
  flowBuyPressure?: number;
  finalDrawdownPct?: number;
  growthPerMin?: number;
  maxDrawdownPct?: number;
  flatIntervals?: number;
}

function emptyEarlyFlowOutcome(finalPrice: number, reason: string): EarlyFlowOutcome {
  return {
    confirmed: false,
    finalPrice,
    ageSeconds: 0,
    buyPressure: 0,
    netFlowPct: 0,
    priceChangePercent: 0,
    drawdownPercent: 0,
    flatRatio: 0,
    volatility: 0,
    uniqueBuyers: 0,
    uniqueSellers: 0,
    buyTransactionCount: 0,
    sellTransactionCount: 0,
    topBuyerConcentration: 0,
    curveDepthSol: 0,
    priceImpactBps: 0,
    quoteAgeMs: 0,
    opportunityScore: 0,
    gateViolations: [],
    samples: 0,
    failedReads: 0,
    reason,
    flowBuyPressure: 0,
    finalDrawdownPct: 0,
    growthPerMin: 0,
    maxDrawdownPct: 0,
    flatIntervals: 0,
  };
}

interface ExecutableQuote {
  price: number;
  timestamp: number;
  priceImpactBps: number;
  estimatedFeeSol?: number;
  route?: string;
}

type RiskLevel = 'SAFE' | 'CAUTION' | 'HIGH_RISK' | 'BLOCKED';

interface RiskAssessment {
  score: number;
  level: RiskLevel;
  canTrade: boolean;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface TokenRiskGate {
  assess(input: {
    tokenMint: string;
    poolAddress?: string | undefined;
    source: string;
    initialLiquidity: number;
    quote: ExecutableQuote;
    isPumpFun: boolean;
  }): Promise<RiskAssessment>;
}

/**
 * Token-scoped emergency exit.
 *
 * REQUIRED, not optional. This was previously an optional method that the
 * handler duck-typed for at call time: if the engine did not expose it, a
 * critical liquidity alert logged a line and returned, performing no exit
 * at all. A rug alert that results in no action is worse than no alert,
 * because it reads as "handled" in the logs. `MayhemEngine` now implements
 * this, and the constructor asserts it exists so a wiring mistake fails at
 * startup rather than during a rug.
 */
interface TokenScopedExitEngine {
  emergencyExitToken(
    tokenMint: string,
    reason: string,
  ): Promise<Array<{ id: string }>>;
}

type RuntimeConfig = BotConfig & {
    // ============================================================
  // RESEARCH / DATA COLLECTION
  // ============================================================

  /**
   * Research mode records every discovered token regardless of
   * whether the trading gates approve or reject it.
   *
   * IMPORTANT:
   * This is intentionally independent from TRADING_ENABLED.
   */
  RESEARCH_MODE_ENABLED: boolean;

  /**
   * Persist the initial discovery snapshot before any filtering.
   */
  RESEARCH_RECORD_DISCOVERY: boolean;

  /**
   * Persist every enrichment attempt, including failures.
   */
  RESEARCH_RECORD_ENRICHMENT: boolean;

  /**
   * Persist every observation sample.
   */
  RESEARCH_RECORD_SAMPLES: boolean;

  /**
   * Persist every rejection with the complete metric set.
   */
  RESEARCH_RECORD_REJECTIONS: boolean;

  /**
   * Persist approved/entered tokens with the complete entry snapshot.
   */
  RESEARCH_RECORD_ENTRIES: boolean;

  /**
   * Persist tokens even when RPC data is unavailable.
   *
   * Missing data must be represented as NULL/UNAVAILABLE,
   * never silently converted to zero.
   */
  RESEARCH_RECORD_INCOMPLETE: boolean;

  /**
   * Research observation window.
   */
  RESEARCH_OBSERVATION_WINDOW_MS: number;

  /**
   * Research sampling interval.
   */
  RESEARCH_SAMPLE_INTERVAL_MS: number;

  /**
   * Maximum samples per token.
   */
  RESEARCH_MAX_SAMPLES: number;

  /**
   * Maximum concurrent research observations.
   */
  RESEARCH_MAX_CONCURRENT_OBSERVATIONS: number;

  /**
   * Commitment used for research RPC reads.
   */
  RESEARCH_RPC_COMMITMENT: 'processed' | 'confirmed' | 'finalized';

  /**
   * Record the RPC slot for every observation.
   */
  RESEARCH_RECORD_SLOT: boolean;

  /**
   * Record timestamps with millisecond precision.
   */
  RESEARCH_RECORD_TIMESTAMPS: boolean;

  /**
   * Collect holder information.
   */
  RESEARCH_COLLECT_HOLDERS: boolean;

  /**
   * Number of largest token accounts to retain.
   *
   * Solana's standard RPC method exposes the largest 20 accounts.
   */
  RESEARCH_MAX_TOP_HOLDERS: number;

  /**
   * Collect token account / holder distribution.
   */
  RESEARCH_COLLECT_HOLDER_DISTRIBUTION: boolean;

  /**
   * Collect bonding-curve state for pump.fun tokens.
   */
  RESEARCH_COLLECT_CURVE_STATE: boolean;

  /**
   * Collect pool state for graduated / DEX tokens.
   */
  RESEARCH_COLLECT_POOL_STATE: boolean;

  /**
   * Collect transaction-flow statistics.
   */
  RESEARCH_COLLECT_TRANSACTION_FLOW: boolean;

  /**
   * Collect buy/sell volume.
   */
  RESEARCH_COLLECT_BUY_SELL_VOLUME: boolean;

  /**
   * Collect unique buyer/seller counts.
   */
  RESEARCH_COLLECT_UNIQUE_TRADERS: boolean;

  /**
   * Collect largest buy/sell transaction.
   */
  RESEARCH_COLLECT_LARGEST_TRADES: boolean;

  /**
   * Collect transaction velocity.
   */
  RESEARCH_COLLECT_TRANSACTION_VELOCITY: boolean;

  /**
   * Collect price-impact information.
   */
  RESEARCH_COLLECT_PRICE_IMPACT: boolean;

  /**
   * Collect executable quote information.
   */
  RESEARCH_COLLECT_QUOTES: boolean;

  /**
   * Quote freshness requirement for research.
   *
   * This should NOT discard the observation. It should record the
   * quote and mark it stale.
   */
  RESEARCH_MAX_QUOTE_AGE_MS: number;

  /**
   * Keep failed RPC reads as explicit observations.
   */
  RESEARCH_RECORD_RPC_FAILURES: boolean;

  /**
   * Keep the reason for every unavailable metric.
   */
  RESEARCH_RECORD_DATA_STATUS: boolean;

  /**
   * Cache immutable-ish token metadata.
   */
  RESEARCH_METADATA_CACHE_TTL_MS: number;

  /**
   * Cache size.
   */
  RESEARCH_METADATA_CACHE_MAX: number;
  
  TRADING_ENABLED: boolean;
  MIN_LIQUIDITY_SOL: number;
  MOMENTUM_CONFIRM_ENABLED: boolean;
  MOMENTUM_CONFIRM_DURATION_MS: number;
  MOMENTUM_CONFIRM_INTERVAL_MS: number;
  /**
   * Candidates admitted concurrently into the quote/risk/momentum phase.
   *
   * Total sustained RPC load scales with this multiplied by the momentum
   * sampling rate, so it is the single knob that bounds discovery-side cost.
   */
  MAX_CONCURRENT_EVALUATIONS: number;
  MIN_MOMENTUM_CHANGE_PCT: number;
  /**
   * Minimum share of non-flat sampling intervals that rose (STRATEGY.md §3.4).
   *
   * Replaces MIN_MOMENTUM_UPTICK_RATIO. The old name described a quantity that
   * counted flat intervals as up-ticks; the rename is deliberate so a stale
   * .env key cannot silently supply a value to the corrected rule.
   */
  MIN_BUY_PRESSURE: number;
  /** Maximum stdev of log returns. Rejects curves too erratic to price. */
  MAX_MOMENTUM_VOLATILITY: number;
  MAX_MOMENTUM_DRAWDOWN_PCT: number;
  /** Activity floor: max share of sampling intervals with no price movement. */
  MAX_FLAT_RATIO: number;
  MIN_MOMENTUM_SAMPLES: number;
  MIN_RISK_SCORE: number;
  MAX_ENTRY_PRICE_IMPACT_BPS: number;
  MAX_QUOTE_AGE_MS: number;
  // Early-flow mode parameters
  MAYHEM_ENTRY_MODE?: 'EARLY_FLOW' | 'MOMENTUM';
  EARLY_FLOW_WINDOW_MS?: number;
  EARLY_FLOW_SAMPLE_INTERVAL_MS?: number;
  MIN_EARLY_FLOW_SAMPLES?: number;
  MAX_EARLY_FLOW_SAMPLES?: number;
  MIN_NET_FLOW_PCT?: number;
  MAX_EARLY_VOLATILITY?: number;
  MAX_EARLY_DRAW_DOWN_PCT?: number;
  MIN_UNIQUE_BUYERS?: number;
  MIN_BUY_TRANSACTIONS?: number;
  MIN_CURVE_DEPTH_SOL?: number;
  MIN_CURVE_RESERVE_SOL?: number;
  MAX_TOP_BUYER_CONCENTRATION?: number;
  MAX_SELL_PRESSURE?: number;
  MIN_OPPORTUNITY_SCORE?: number;
};

export class NewLaunchHandler {
  private readonly mayhemEngine: MayhemEngine;
  private readonly executionEngine: any;
  private readonly config: RuntimeConfig;
  private readonly candidateManager = new CandidateManager();
  private readonly circuitBreaker: CircuitBreaker;
  private readonly riskGate: TokenRiskGate;

  /** Mints with a candidate lifecycle currently in flight. */
  private readonly activeMints = new Set<string>();

  /*
   * Candidates currently inside the RPC-expensive phase of the lifecycle
   * (quote -> risk evidence -> momentum sampling).
   *
   * This was previously unbounded: every discovered mint immediately began a
   * 60s momentum loop polling the bonding curve every 2s, concurrently with
   * every other candidate discovered in that window. At the observed launch
   * rate that is several sustained RPC calls per second from momentum alone,
   * on top of discovery and risk evidence — enough to have the endpoint
   * return 429 for everything, including the price reads the open positions
   * depend on.
   *
   * A saturated endpoint does not degrade gracefully here: `getPrice` falls
   * back to a constant, and the engine cannot tell a flat market from a dead
   * feed. Bounding admission is what keeps the calls that matter answerable.
   */
  private inFlightEvaluations = 0;

  /** Mints holding an open position: mint -> positionId. */
  private readonly openMints = new Map<string, string>();

  constructor(
    mayhemEngine: MayhemEngine,
    executionEngine: any,
    config: RuntimeConfig,
    riskGate: TokenRiskGate,
    circuitBreaker: CircuitBreaker,
    /** Signed sink for rejection telemetry. Optional: absence disables it. */
    private readonly telemetrySink?: { post(path: string, payload: unknown): Promise<void> },
  ) {
    this.mayhemEngine = mayhemEngine;
    this.executionEngine = executionEngine;
    this.config = config;
    this.riskGate = riskGate;
    this.circuitBreaker = circuitBreaker;

    // Fail at wiring time, not at rug time.
    if (
      typeof (mayhemEngine as unknown as TokenScopedExitEngine)
        .emergencyExitToken !== 'function'
    ) {
      throw new Error(
        'NewLaunchHandler requires an engine implementing emergencyExitToken(): ' +
          'without it a critical liquidity alert cannot close the position.',
      );
    }
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  getCandidateStats() {
    return this.candidateManager.getStats();
  }

  async handleNewToken(event: TokenDiscoveryEvent): Promise<void> {
     if (
      event.source.startsWith('raydium-lp:') &&
      event.poolVerificationStatus !== 'verified'
     ) {
      logger.warn('REJECTED_UNVERIFIED_RAYDIUM_POOL', {
        mint: event.tokenMint,
        source: event.source,
        poolAddress: event.poolAddress,
        verificationStatus: event.poolVerificationStatus ?? 'not-provided',
        verificationReason:
          event.poolVerificationReason ?? 'no verification reason provided',
      });

      return;
    }

      if (!event.tokenMint || event.tokenMint === 'unknown') {
        logger.warn('REJECTED_INVALID_MINT', { tokenMint: event.tokenMint });
        return;
      }

      if (!this.reserveMint(event.tokenMint)) {
      logger.debug?.('CANDIDATE_ALREADY_ACTIVE_OR_DUPLICATE', {
        mint: event.tokenMint,
      });
      return;
    }

    let candidate: Candidate | undefined;
    let openedPositionId: string | null = null;
    let evaluationSlotHeld = false;

    try {
      const breakerResult = this.circuitBreaker.shouldBlock();
      if (breakerResult.block) {
        logger.warn('CIRCUIT_BREAKER_BLOCKED', {
          mint: event.tokenMint,
          reason: breakerResult.reason,
        });
        return;
      }

      candidate = this.candidateManager.create(event.tokenMint, event.source);

      logger.info('CANDIDATE_DETECTED', {
        id: candidate.id,
        mint: event.tokenMint,
        source: event.source,
      });

      this.candidateManager.transition(
        candidate,
        'VALIDATING',
        'starting finalized-event validation',
      );

      // Trust the discovery wiring, which knows which program it watched.
      // Falling back to the address suffix only when it was not supplied.
      const isPumpFun = event.isPumpFun ?? isPumpFunToken(event.tokenMint);
      const liquidity = this.getValidatedLiquidity(event.initialLiquidity);

      if (!isPumpFun && liquidity < this.config.MIN_LIQUIDITY_SOL) {
        return this.reject(
          candidate,
          `liquidity ${liquidity} < minimum ${this.config.MIN_LIQUIDITY_SOL}`,
          'REJECTED_LOW_LIQ',
          {
            mint: event.tokenMint,
            liquidity,
            minimumLiquidity: this.config.MIN_LIQUIDITY_SOL,
          },
        );
      }

      if (!event.poolAddress && !isPumpFun) {
        return this.reject(
          candidate,
          'missing confirmed pool address',
          'REJECTED_NO_POOL',
          { mint: event.tokenMint },
        );
      }

      /*
       * Admission control for the RPC-expensive phase.
       *
       * Placed here deliberately: everything above is local arithmetic, and
       * `getValidatedQuote` below is the first network call. Shedding here
       * costs nothing, whereas shedding after risk evidence would already
       * have paid for the lookups.
       *
       * Rejected rather than queued. A queued candidate is sampled minutes
       * after launch, which is a different trade than the one the strategy
       * describes — better to decline it and say so than to take it late.
       */
      const evaluationCap = this.config.MAX_CONCURRENT_EVALUATIONS ?? 3;
      if (this.inFlightEvaluations >= evaluationCap) {
        return this.reject(
          candidate,
          `evaluation capacity reached (${this.inFlightEvaluations}/${evaluationCap})`,
          'REJECTED_EVALUATION_CAPACITY',
          {
            mint: event.tokenMint,
            inFlight: this.inFlightEvaluations,
            cap: evaluationCap,
          },
        );
      }

      this.inFlightEvaluations += 1;
      evaluationSlotHeld = true;

      const quote = await this.getValidatedQuote(event.tokenMint);
      if (!quote) {
        return this.reject(
          candidate,
          'missing, stale, invalid, or excessively expensive executable quote',
          'REJECTED_INVALID_QUOTE',
          { mint: event.tokenMint },
        );
      }

      candidate.price = quote.price;
      candidate.liquidity = liquidity;

      const riskInput: {
        tokenMint: string;
        source: string;
        initialLiquidity: number;
        quote: ExecutableQuote;
        isPumpFun: boolean;
        poolAddress?: string | undefined;
      } = {
        tokenMint: event.tokenMint,
        source: event.source,
        initialLiquidity: liquidity,
        quote,
        isPumpFun,
      };

      if (event.poolAddress) {
        riskInput.poolAddress = event.poolAddress;
      }

      const risk = await this.riskGate.assess(riskInput);

      const minRiskScore = this.config.MIN_RISK_SCORE ?? 80;

      if (
        !risk.canTrade ||
        risk.level === 'HIGH_RISK' ||
        risk.level === 'BLOCKED' ||
        !Number.isFinite(risk.score) ||
        risk.score < minRiskScore
      ) {
        return this.reject(
          candidate,
          `risk rejected: ${risk.reason ?? 'risk threshold not met'}`,
          'REJECTED_RISK',
          {
            mint: event.tokenMint,
            score: risk.score,
            level: risk.level,
            minRiskScore,
            evidence: risk.evidence,
          },
        );
      }

      candidate.riskScore = risk.score;

      const momentum = await this.confirmMomentum(
        event.tokenMint,
        quote.price,
      );

      /*
      * Record the COMPLETE momentum observation before making the entry decision.
      *
      * Research-stage rule:
      * Every token gets its measured signal data recorded, whether it passes
      * or fails. Do not discard rejected observations because they are essential
      * for later threshold calibration and statistical analysis.
      */
      
      const momentumTelemetry = {
      mint: event.tokenMint,

      // Decision
      confirmed: momentum.confirmed,
      reason: momentum.reason,

      // Price / momentum
      initialPrice: quote.price,
      finalPrice: momentum.finalPrice,
      growthPerMin: Number(momentum.growthPerMin.toFixed(6)),
      netFlowPct: Number(momentum.netFlowPct.toFixed(6)),

     // Buy / sell pressure
      buyPressure: Number(momentum.buyPressure.toFixed(6)),
      flowBuyPressure: Number(momentum.flowBuyPressure.toFixed(6)),

      // Drawdown
      maxDrawdownPct: Number(momentum.maxDrawdownPct.toFixed(6)),
      finalDrawdownPct: Number(momentum.finalDrawdownPct.toFixed(6)),

      // Market activity
      flatRatio: Number(momentum.flatRatio.toFixed(6)),
      flatIntervals: momentum.flatIntervals,
      volatility: Number(momentum.volatility.toFixed(8)),

      // Sampling quality
      samples: momentum.samples,
      failedReads: momentum.failedReads,

      // Timestamp
      observedAt: new Date().toISOString(),
    };

    /*
    * IMPORTANT:
    * Emit the complete observation BEFORE the gate can return.
     *
    * This guarantees that rejected tokens remain in the research dataset.
    */
    logger.info('MOMENTUM_EVALUATION', momentumTelemetry);

    const {
      mint: _mint,
      reason: _reason,
      ...momentumResearch
    } = momentumTelemetry;

    this.mayhemEngine.getResearchRecorder().recordObservation({
      event: 'MOMENTUM_EVALUATION',
      mint: event.tokenMint,
      tokenMint: event.tokenMint,
      source: event.source,
      outcome: momentum.confirmed ? 'confirmed' : 'rejected',
      reason: momentum.reason,
      ...momentumResearch,
    });

    /*
     * Also forward the complete observation to the telemetry API when available.
     * This should eventually be persisted in a dedicated research/evaluations
     * table rather than relying exclusively on application logs.
     */
    if (this.telemetrySink) {
      void this.telemetrySink.post('/internal/telemetry', {
        event: 'MOMENTUM_EVALUATION',
        candidateId: candidate.id,
        timestamp: new Date().toISOString(),
        context: momentumTelemetry,
      });
    }

    if (!momentum.confirmed) {
      return this.reject(
        candidate,
        `momentum rejected: ${momentum.reason}`,
        'REJECTED_MOMENTUM',
        momentumTelemetry,
      );
    }

    if (!this.config.TRADING_ENABLED) {
      return this.reject(
        candidate,
        'monitor-only mode: research evaluation complete, no entry executed',
        'REJECTED_MONITOR_ONLY',
        {
          mint: event.tokenMint,
          tradingEnabled: this.config.TRADING_ENABLED,
          source: event.source,
          riskScore: risk.score,
          momentumConfirmed: momentum.confirmed,
          momentumReason: momentum.reason,
          observedAt: momentumTelemetry.observedAt,
        },
      );
    }

    /*
    * Record the COMPLETE entry-time signal on approval.
    *
    * Do not reduce this to riskScore/price/buyPressure/etc. The research
    * dataset needs the exact observation that caused the entry.
    */
    this.candidateManager.transition(
      candidate,
      'APPROVED',
      'risk and momentum passed',
      {
        riskScore: risk.score,
        price: momentum.finalPrice,

        // Full momentum observation
        buyPressure: momentum.buyPressure,
        flowBuyPressure: momentum.flowBuyPressure,
        netFlowPct: momentum.netFlowPct,
        growthPerMin: momentum.growthPerMin,

        maxDrawdownPct: momentum.maxDrawdownPct,
        finalDrawdownPct: momentum.finalDrawdownPct,

        flatRatio: momentum.flatRatio,
        flatIntervals: momentum.flatIntervals,
        volatility: momentum.volatility,

        samples: momentum.samples,
        failedReads: momentum.failedReads,

        momentumConfirmed: momentum.confirmed,
        momentumReason: momentum.reason,

        observedAt: momentumTelemetry.observedAt,
      } as any,
    );

      logger.info('SIGNAL_CONFIRMED', {
        mint: event.tokenMint,
        buyPressure: Number(momentum.buyPressure.toFixed(3)),
        netFlowPct: Number(momentum.netFlowPct.toFixed(3)),
        volatility: Number(momentum.volatility.toFixed(5)),
        growthPerMin: Number(momentum.growthPerMin.toFixed(3)),
        drawdownPct: Number(momentum.maxDrawdownPct.toFixed(3)),
        samples: momentum.samples,
        failedReads: momentum.failedReads,
      });

      const entryGate = this.circuitBreaker.shouldBlock();
      if (entryGate.block) {
        return this.reject(
          candidate,
          'circuit breaker opened before entry',
          'REJECTED_CIRCUIT_BREAKER',
          { mint: event.tokenMint, reason: entryGate.reason },
        );
      }

      this.candidateManager.transition(candidate, 'PENDING_ENTRY', 'requesting entry');

      /*
       * Depth basis for position sizing.
       *
       * `liquidity` here is pool liquidity, which is structurally 0 for a
       * pre-graduation pump.fun token: there is no pool, the supply is in the
       * bonding curve. Passing that 0 to `evaluateToken` makes the engine
       * fail closed on the entire pump.fun universe.
       *
       * The curve's real SOL reserves are the correct constraint — they are
       * what a sell actually draws down — so resolve them here and let the
       * engine apply the same participation cap it applies to a pool.
       *
       * Read once, at entry, rather than per monitor tick: this costs one
       * account read per candidate that survives momentum confirmation,
       * which is a small fraction of discovered mints.
       */
      let depthSol = liquidity;

      /*
       * Whether depth was actually READ, as opposed to merely absent.
       *
       * Only a successful curve read sets this. It is what entitles the
       * engine to size a zero-depth launch on the fixed risk budget instead
       * of rejecting it — so it must never be set optimistically. An
       * unreadable curve stays `false` and is rejected below.
       */
      let depthMeasured = false;

      if (depthSol <= 0 && isPumpFun) {
        const curveDepth =
          typeof this.executionEngine?.getDepthSol === 'function'
            ? await this.executionEngine.getDepthSol(event.tokenMint)
            : null;

        if (curveDepth === null) {
          return this.reject(
            candidate,
            'bonding curve depth unavailable; cannot bound position size',
            'REJECTED_DEPTH_UNKNOWN',
            { mint: event.tokenMint },
          );
        }

        depthSol = curveDepth;
        depthMeasured = true;
      }

      logger.info('DEPTH_RESOLVED', {
        mint: event.tokenMint,
        poolLiquiditySol: liquidity,
        depthSol,
        depthMeasured,
        basis: depthSol > 0 ? 'measured_depth' : 'measured_zero_depth',
      });

      const signal = this.mayhemEngine.evaluateToken(
        event.tokenMint,
        momentum.finalPrice,
        depthSol,
        risk.score,
        { depthMeasured },
      );

      if (!signal) {
        return this.reject(
          candidate,
          'entry signal rejected by portfolio or position limits',
          'REJECTED_NO_SIGNAL',
          { mint: event.tokenMint },
        );
      }

      // Record the BUY decision in the research dataset
      // This captures the exact moment and conditions under which we approved entry
      try {
        this.mayhemEngine.getResearchRecorder().recordDecision({
          recordId: `decision:${candidate.id}`,
          tokenMint: event.tokenMint,
          mint: event.tokenMint,
          decision: 'BUY',
          reason: 'momentum and risk gates passed',
          candidateId: candidate.id,
          riskScore: risk.score,
          riskLevel: risk.level,
          price: signal.price,
          amount: signal.amount,
          momentum: {
            confirmed: momentum.confirmed,
            finalPrice: momentum.finalPrice,
            growthPerMin: momentum.growthPerMin,
            buyPressure: momentum.buyPressure,
            flowBuyPressure: momentum.flowBuyPressure,
            maxDrawdownPct: momentum.maxDrawdownPct,
            finalDrawdownPct: momentum.finalDrawdownPct,
            volatility: momentum.volatility,
          },
          isPumpFun,
          liquidity,
          depthSol,
          depthMeasured,
          source: event.source,
          recordedAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.warn('RESEARCH_RECORD_DECISION_FAILED', {
          candidateId: candidate.id,
          decision: 'BUY',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const position = await this.mayhemEngine.executeEntry(signal);

      if (!position) {
        this.candidateManager.transition(
          candidate,
          'FAILED',
          'execution returned no confirmed position',
        );

        logger.warn('ENTRY_FAILED', {
          candidateId: candidate.id,
          mint: event.tokenMint,
        });

        return;
      }

      // Record the open position BEFORE any further bookkeeping. If a
      // later statement throws, the `finally` block must still see that a
      // position exists — otherwise it releases the mint reservation while
      // capital is committed, and the next discovery event for this mint
      // opens a second position on top of the first.
      openedPositionId = position.id;

      this.candidateManager.transition(candidate, 'OPEN', 'entry confirmed');
      candidate.positionId = position.id;

      logger.info('ENTRY_OPENED', {
        candidateId: candidate.id,
        positionId: position.id,
        mint: position.tokenMint,
        entry: position.actualEntryPrice,
        amount: signal.amount,
        liquidity,
        riskScore: risk.score,
        source: event.source,
      });
    } catch (error) {
      if (candidate) {
        this.safeFailCandidate(candidate, 'unhandled candidate lifecycle error');
      }

      logger.error('CANDIDATE_LIFECYCLE_FAILED', {
        mint: event.tokenMint,
        error: this.toErrorMessage(error),
      });
    } finally {
      // Released on EVERY exit path — including the `return this.reject(...)`
      // calls, which are returns out of the try block. A slot leaked on a
      // rejection path would permanently shrink the cap until restart.
      if (evaluationSlotHeld) {
        this.inFlightEvaluations -= 1;
      }

      // Release the reservation ONLY when no position was opened.
      //
      // Previously this always released, so duplicate protection fell back
      // to CandidateManager.isDuplicate — whose `seenMints` set is trimmed,
      // meaning a mint seen long enough ago could be re-discovered and
      // entered a second time while the first position was still open.
      // A mint with a live position stays reserved until releaseMint() is
      // called from the position-closed handler.
      if (openedPositionId === null) {
        this.activeMints.delete(event.tokenMint);
      } else {
        this.openMints.set(event.tokenMint, openedPositionId);
      }
    }
  }

  /**
   * Release a mint once its position is fully closed. Wired to the engine's
   * `exit` event in apps/bot/src/index.ts.
   */
  releaseMint(tokenMint: string): void {
    this.openMints.delete(tokenMint);
    this.activeMints.delete(tokenMint);
  }

  /** Mints currently holding an open position. */
  getOpenMints(): string[] {
    return [...this.openMints.keys()];
  }

  async handleMempoolSnipe(event: PendingLpEvent): Promise<void> {
    logger.warn('MEMPOOL_EXECUTION_DISABLED', {
      mint: event.tokenMint,
      programId: event.programId,
      detectedAt: event.detectedAt,
    });
  }

  async handleLiquidityAlert(alert: LiquidityAlert): Promise<void> {
    logger.error('LIQUIDITY_ALERT_RECEIVED', {
      token: alert.tokenMint,
      pool: alert.poolAddress,
      type: alert.alertType,
      severity: alert.severity,
    });

    const scopedExit = this.mayhemEngine as unknown as TokenScopedExitEngine;

    try {
      const closed = await scopedExit.emergencyExitToken(
        alert.tokenMint,
        `liquidity_alert:${alert.alertType}:${alert.tokenMint}`,
      );

      logger.warn('TOKEN_EMERGENCY_EXIT_COMPLETED', {
        token: alert.tokenMint,
        closedPositions: closed.length,
      });
    } catch (error) {
      logger.error('TOKEN_EMERGENCY_EXIT_FAILED', {
        token: alert.tokenMint,
        error: this.toErrorMessage(error),
      });
    }
  }

  private reserveMint(mint: string): boolean {
    // Already being processed.
    if (this.activeMints.has(mint)) {
      return false;
    }

    // Already holds an open position. This check does not rely on the
    // candidate manager's trimmed `seenMints` set, so it cannot be aged out
    // while the position is still live.
    if (this.openMints.has(mint)) {
      return false;
    }

    if (this.candidateManager.isDuplicate(mint)) {
      return false;
    }

    this.activeMints.add(mint);
    return true;
  }

  private getValidatedLiquidity(initialLiquidity: number | null | undefined): number {
    if (
      initialLiquidity === null ||
      initialLiquidity === undefined ||
      !Number.isFinite(initialLiquidity) ||
      initialLiquidity < 0
    ) {
      return 0;
    }

    return initialLiquidity;
  }

  private async getValidatedQuote(mint: string): Promise<ExecutableQuote | null> {
    try {
      const engine = this.executionEngine as unknown as {
        getExecutableQuote?: (
          tokenMint: string,
        ) => Promise<ExecutableQuote>;
      };

      if (typeof engine.getExecutableQuote === 'function') {
        const quote = await engine.getExecutableQuote(mint);

        if (!this.isValidQuote(quote)) {
          return null;
        }

        return quote;
      }

      const price = await this.executionEngine.getPrice(mint);

      if (!Number.isFinite(price) || price <= 0) {
        return null;
      }

      return {
        price,
        timestamp: Date.now(),
        priceImpactBps: 0,
      };
    } catch (error) {
      logger.warn('QUOTE_LOOKUP_FAILED', {
        mint,
        error: this.toErrorMessage(error),
      });

      return null;
    }
  }

  private isValidQuote(quote: ExecutableQuote): boolean {
    const maxQuoteAgeMs = (this.config as any).MAX_QUOTE_AGE_MS ?? 5_000;
    const maxPriceImpactBps = (this.config as any).MAX_ENTRY_PRICE_IMPACT_BPS ?? 500;
    const quoteAgeMs = Date.now() - quote.timestamp;

    return (
      Number.isFinite(quote.price) &&
      quote.price > 0 &&
      Number.isFinite(quote.timestamp) &&
      quoteAgeMs >= 0 &&
      quoteAgeMs <= maxQuoteAgeMs &&
      Number.isFinite(quote.priceImpactBps) &&
      quote.priceImpactBps >= 0 &&
      quote.priceImpactBps <= maxPriceImpactBps
    );
  }

  /**
   * Observe the curve, then apply the entry rule — STRATEGY.md §3.3 / §3.4.
   *
   * Sampling (I/O) and evaluation (arithmetic) are separated: this method only
   * gathers samples and delegates the decision to `evaluateSignal`, which is
   * pure and exhaustively unit-tested. The previous version inlined both, so
   * the decision rule could not be exercised without a live RPC connection.
   */
  private async confirmMomentum(
    mint: string,
    initialPrice: number,
  ): Promise<MomentumOutcome> {
    if (!Number.isFinite(initialPrice) || initialPrice <= 0) {
      return emptyMomentumOutcome(0, 'invalid initial price');
    }

    if (!this.config.MOMENTUM_CONFIRM_ENABLED) {
      return { ...emptyMomentumOutcome(initialPrice, 'momentum confirmation disabled'), confirmed: true };
    }

    const durationMs = this.config.MOMENTUM_CONFIRM_DURATION_MS ?? 60_000;
    const intervalMs = this.config.MOMENTUM_CONFIRM_INTERVAL_MS ?? 2_000;

    const thresholds: SignalThresholds = {
      minSamples: this.config.MIN_MOMENTUM_SAMPLES ?? 10,
      minBuyPressure: this.config.MIN_BUY_PRESSURE ?? 0.65,
      minNetFlowPct: this.config.MIN_MOMENTUM_CHANGE_PCT ?? 2,
      maxVolatility: this.config.MAX_MOMENTUM_VOLATILITY ?? 0.5,
      maxDrawdownPct: this.config.MAX_MOMENTUM_DRAWDOWN_PCT ?? 10,
      maxFlatRatio: this.config.MAX_FLAT_RATIO ?? 0.8,
    };

    /*
     * Refuse to trade on a nonsensical rule rather than silently substituting
     * defaults. A threshold set that can never reject is indistinguishable at
     * runtime from a filter that is working.
     */
    const thresholdProblems = validateThresholds(thresholds);
    if (thresholdProblems.length > 0) {
      return emptyMomentumOutcome(
        initialPrice,
        `invalid signal thresholds: ${thresholdProblems.join('; ')}`,
      );
    }

    if (durationMs < intervalMs || intervalMs < 500) {
      return emptyMomentumOutcome(initialPrice, 'invalid momentum configuration');
    }

    const samples: PriceSample[] = [{ price: initialPrice, timestamp: Date.now() }];
    const ticks = Math.floor(durationMs / intervalMs);

    let failedReads = 0;

    for (let index = 0; index < ticks; index += 1) {
      await this.sleep(intervalMs);

      const quote = await this.getValidatedQuote(mint);
      if (!quote) {
        failedReads += 1;
        continue;
      }

      samples.push({ price: quote.price, timestamp: quote.timestamp });
    }

    const result = evaluateSignal(samples, thresholds);
    const metrics = result.metrics;
    const finalPrice = metrics?.finalPrice ?? samples[samples.length - 1]?.price ?? initialPrice;

    return {
      confirmed: result.confirmed,
      finalPrice,
      // Retained for the existing call site and log schema.
      growthPerMin: metrics?.flowRatePerMin ?? 0,
      maxDrawdownPct: metrics?.maxDrawdownPct ?? 0,
      buyPressure: metrics?.buyPressure ?? 0,
      flowBuyPressure: metrics?.flowBuyPressure ?? 0,
      finalDrawdownPct: metrics?.finalDrawdownPct ?? 0,
      flatRatio:
        metrics && metrics.samples > 1
          ? metrics.flatIntervals / (metrics.samples - 1)
          : 0,
      netFlowPct: metrics?.netFlowPct ?? 0,
      volatility: metrics?.volatility ?? 0,
      samples: metrics?.samples ?? samples.length,
      flatIntervals: metrics?.flatIntervals ?? 0,
      failedReads,
      reason: result.reason,
    };
  }

  private async confirmEarlyFlow(
    mint: string,
    initialPrice: number,
  ): Promise<EarlyFlowOutcome> {
    if (!Number.isFinite(initialPrice) || initialPrice <= 0) {
      return emptyEarlyFlowOutcome(0, 'invalid initial price');
    }

    // Read runtime parameters with sensible fallbacks.
    const windowMs = this.config.EARLY_FLOW_WINDOW_MS ?? 5000;
    const intervalMs = this.config.EARLY_FLOW_SAMPLE_INTERVAL_MS ?? 1000;
    const minSamples = this.config.MIN_EARLY_FLOW_SAMPLES ?? 3;
    const maxSamples = this.config.MAX_EARLY_FLOW_SAMPLES ?? 5;

    if (windowMs < intervalMs || intervalMs < 250) {
      return emptyEarlyFlowOutcome(initialPrice, 'invalid early-flow configuration');
    }

    const samples: PriceSample[] = [{ price: initialPrice, timestamp: Date.now() }];
    let failedReads = 0;
    let lastQuote: ExecutableQuote | null = null;

    const ticks = Math.min(maxSamples, Math.max(1, Math.floor(windowMs / intervalMs)));

    for (let i = 0; i < ticks; i += 1) {
      await this.sleep(intervalMs);
      const quote = await this.getValidatedQuote(mint);
      if (!quote) {
        failedReads += 1;
        continue;
      }
      lastQuote = quote;
      samples.push({ price: quote.price, timestamp: quote.timestamp });
    }

    const thresholds: SignalThresholds = {
      minSamples,
      minBuyPressure: this.config.MIN_BUY_PRESSURE ?? 0.55,
      minNetFlowPct: this.config.MIN_NET_FLOW_PCT ?? 5,
      maxVolatility: this.config.MAX_EARLY_VOLATILITY ?? 0.5,
      maxDrawdownPct: this.config.MAX_EARLY_DRAW_DOWN_PCT ?? 15,
      maxFlatRatio: this.config.MAX_FLAT_RATIO ?? 0.6,
    };

    const thresholdProblems = validateThresholds(thresholds);
    if (thresholdProblems.length > 0) {
      return emptyEarlyFlowOutcome(initialPrice, `invalid early-flow thresholds: ${thresholdProblems.join('; ')}`);
    }

    const result = evaluateSignal(samples, thresholds);
    const metrics = result.metrics;
    const finalPrice = metrics?.finalPrice ?? samples[samples.length - 1]?.price ?? initialPrice;

    // Fetch curve depth if available
    let curveDepth = 0;
    if (typeof this.executionEngine?.getDepthSol === 'function') {
      try {
        const d = await this.executionEngine.getDepthSol(mint);
        if (d !== null) curveDepth = d;
      } catch {
        curveDepth = 0;
      }
    }

    // Hard-required data checks. If any are missing, record DATA_INSUFFICIENT
    // and do not attempt an entry.
    const maxQuoteAgeMs = this.config.MAX_QUOTE_AGE_MS ?? 1000;
    const minCurveDepth = this.config.MIN_CURVE_DEPTH_SOL ?? 3;
    const requiredProblems: string[] = [];

    if (!lastQuote) {
      requiredProblems.push('NO_QUOTE');
    } else if (Date.now() - lastQuote.timestamp > maxQuoteAgeMs) {
      requiredProblems.push('STALE_QUOTE');
    }

    if (!metrics) {
      requiredProblems.push('NO_FLOW_METRICS');
    } else {
      if (!Number.isFinite(metrics.buyPressure)) requiredProblems.push('NO_BUY_PRESSURE');
      if (!Number.isFinite(metrics.flowBuyPressure)) requiredProblems.push('NO_FLOW_BUY_PRESSURE');
      if (!Number.isFinite(metrics.netFlowPct)) requiredProblems.push('NO_NET_FLOW');
      if (!Number.isFinite(metrics.finalDrawdownPct)) requiredProblems.push('NO_DRAWDOWN');
    }

    if (!Number.isFinite(curveDepth) || curveDepth < minCurveDepth) {
      requiredProblems.push('INSUFFICIENT_CURVE_DEPTH');
    }

    if (requiredProblems.length > 0) {
      const evalRecord = {
        samples: samples.length,
        buyPressure: metrics?.buyPressure ?? null,
        sellPressure: null,
        netFlowPct: metrics?.netFlowPct ?? null,
        uniqueBuyers: null,
        uniqueSellers: null,
        buyTransactions: null,
        sellTransactions: null,
        buyVolumeSol: null,
        sellVolumeSol: null,
        buySellVolumeRatio: null,
        transactionVelocity: null,
        largestBuySol: null,
        largestSellSol: null,
        topBuyerConcentration: null,
        curveReserveSol: null,
        curveDepthSol: curveDepth,
        curveProgressPct: null,
        reserveChangeSol: null,
        priceChangePct: metrics?.netFlowPct ?? null,
        priceImpactBps: lastQuote?.priceImpactBps ?? null,
        drawdownPct: metrics?.finalDrawdownPct ?? null,
        volatility: metrics?.volatility ?? null,
        flatRatio: metrics ? (metrics.flatIntervals / Math.max(1, metrics.samples - 1)) : null,
        opportunityScore: null,
        confidence: 0,
        decision: 'DATA_INSUFFICIENT',
        reason: requiredProblems.join(';'),
        metricStatus: {
          uniqueBuyers: 'UNAVAILABLE',
          uniqueSellers: 'UNAVAILABLE',
          largestBuySol: 'UNAVAILABLE',
          largestSellSol: 'UNAVAILABLE',
          topBuyerConcentration: 'UNAVAILABLE',
          transactionVelocity: 'UNAVAILABLE',
          reserveGrowth: 'UNAVAILABLE',
        },
      };

      logger.info('EARLY_FLOW_EVALUATION', evalRecord);

      return emptyEarlyFlowOutcome(finalPrice, `DATA_INSUFFICIENT: ${requiredProblems.join(';')}`);
    }

    // Compute a simple opportunity score from available metrics.
    // Weigh components (sum to 1): flow 0.25, velocity 0.15, depth 0.15, price 0.10, drawdown 0.05, execution 0.10, buyer growth placeholder 0.20
    const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

    const flowBuy = metrics?.flowBuyPressure ?? 0; // 0..1
    const flowScore = clamp((flowBuy - (this.config.MIN_BUY_PRESSURE ?? 0.55)) / (1 - (this.config.MIN_BUY_PRESSURE ?? 0.55)));
    const velocity = Math.min(200, Math.abs(metrics?.flowRatePerMin ?? 0)) / 200; // heuristic
    const velocityScore = clamp(velocity);
    const depthScore = clamp(curveDepth / 10); // 10 SOL+ is good
    const priceScore = clamp(((metrics?.netFlowPct ?? 0) + 20) / 40); // -20..+20 map to 0..1
    const drawdownScore = 1 - clamp((metrics?.finalDrawdownPct ?? 100) / (this.config.MAX_EARLY_DRAW_DOWN_PCT ?? 15));
    const executionScore = lastQuote ? clamp(1 - (lastQuote.priceImpactBps / ((this.config.MAX_ENTRY_PRICE_IMPACT_BPS ?? 750) + 1))) : 0.5;
    const buyerGrowthScore = 0.5; // placeholder until buyer metrics implemented

    const opportunityScore = Math.round(
      (flowScore * 0.25 + velocityScore * 0.15 + depthScore * 0.15 + priceScore * 0.10 + drawdownScore * 0.05 + executionScore * 0.10 + buyerGrowthScore * 0.20) * 100,
    );

    const gateViolations: string[] = [];
    if (!lastQuote) gateViolations.push('NO_QUOTE');
    if (lastQuote && Date.now() - lastQuote.timestamp > (this.config.MAX_QUOTE_AGE_MS ?? 1000)) gateViolations.push('STALE_QUOTE');
    if (lastQuote && lastQuote.priceImpactBps > (this.config.MAX_ENTRY_PRICE_IMPACT_BPS ?? 750)) gateViolations.push('EXCESSIVE_PRICE_IMPACT');
    if (curveDepth <= 0) gateViolations.push('UNKNOWN_CURVE_DEPTH');
    if (metrics && metrics.finalDrawdownPct > (this.config.MAX_EARLY_DRAW_DOWN_PCT ?? 15)) gateViolations.push('EXCESSIVE_DRAWDOWN');

    const confirmed = result.confirmed && gateViolations.length === 0 && opportunityScore >= (this.config.MIN_OPPORTUNITY_SCORE ?? 75);

    const lastTs = samples[samples.length - 1]?.timestamp ?? Date.now();
    const firstTs = samples[0]?.timestamp ?? Date.now();

    // Mark optional scoring metrics availability. These come from token-monitor
    // or enriched evidence; until wired, flag them UNAVAILABLE and reduce
    // confidence accordingly.
    const optionalMetricStatus: Record<string, 'AVAILABLE' | 'UNAVAILABLE'> = {
      uniqueBuyers: 'UNAVAILABLE',
      uniqueSellers: 'UNAVAILABLE',
      largestBuySol: 'UNAVAILABLE',
      largestSellSol: 'UNAVAILABLE',
      topBuyerConcentration: 'UNAVAILABLE',
      transactionVelocity: 'UNAVAILABLE',
      reserveGrowth: 'UNAVAILABLE',
      curveProgressPct: curveDepth > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
    };

    const optionalMissing = Object.values(optionalMetricStatus).filter(s => s === 'UNAVAILABLE').length;
    const confidence = Math.round(opportunityScore * Math.max(0, 1 - 0.08 * optionalMissing));

    const evalRecord = {
      samples: samples.length,
      buyPressure: metrics?.buyPressure ?? null,
      sellPressure: null,
      netFlowPct: metrics?.netFlowPct ?? null,
      uniqueBuyers: null,
      uniqueSellers: null,
      buyTransactions: null,
      sellTransactions: null,
      buyVolumeSol: null,
      sellVolumeSol: null,
      buySellVolumeRatio: null,
      transactionVelocity: null,
      largestBuySol: null,
      largestSellSol: null,
      topBuyerConcentration: null,
      curveReserveSol: null,
      curveDepthSol: curveDepth,
      curveProgressPct: null,
      reserveChangeSol: null,
      priceChangePct: metrics?.netFlowPct ?? null,
      priceImpactBps: lastQuote?.priceImpactBps ?? null,
      drawdownPct: metrics?.finalDrawdownPct ?? null,
      volatility: metrics?.volatility ?? null,
      flatRatio: metrics ? (metrics.flatIntervals / Math.max(1, metrics.samples - 1)) : null,
      opportunityScore,
      confidence,
      decision: confirmed ? 'ENTER' : 'REJECTED',
      reason: result.reason,
      metricStatus: optionalMetricStatus,
    };

    logger.info('EARLY_FLOW_EVALUATION', evalRecord);

    return {
      confirmed,
      finalPrice,
      ageSeconds: (lastTs - firstTs) / 1000,
      buyPressure: metrics?.buyPressure ?? 0,
      netFlowPct: metrics?.netFlowPct ?? 0,
      flowBuyPressure: metrics?.flowBuyPressure ?? 0,
      finalDrawdownPct: metrics?.finalDrawdownPct ?? 0,
      growthPerMin: metrics?.flowRatePerMin ?? 0,
      maxDrawdownPct: metrics?.maxDrawdownPct ?? 0,
      flatIntervals: metrics?.flatIntervals ?? 0,
      priceChangePercent: metrics?.netFlowPct ?? 0,
      drawdownPercent: metrics?.finalDrawdownPct ?? 0,
      flatRatio: metrics ? (metrics.flatIntervals / Math.max(1, metrics.samples - 1)) : 1,
      volatility: metrics?.volatility ?? 0,
      uniqueBuyers: 0,
      uniqueSellers: 0,
      buyTransactionCount: metrics?.samples ?? samples.length,
      sellTransactionCount: 0,
      topBuyerConcentration: 0,
      curveDepthSol: curveDepth,
      priceImpactBps: lastQuote?.priceImpactBps ?? 0,
      quoteAgeMs: lastQuote ? Date.now() - lastQuote.timestamp : Infinity,
      opportunityScore,
      gateViolations,
      samples: metrics?.samples ?? samples.length,
      failedReads,
      reason: result.reason,
    };
  }

  private reject(
    candidate: Candidate,
    reason: string,
    logEvent: string,
    context: Record<string, unknown>,
  ): void {
    this.candidateManager.reject(candidate, reason);

    logger.info(logEvent, {
      candidateId: candidate.id,
      reason,
      ...context,
    });

    // Record the REJECTION decision in the research dataset
    // so rejected tokens remain traceable through the evaluation pipeline
    const mint = typeof context['mint'] === 'string' ? context['mint'] : candidate.id;
    try {
      this.mayhemEngine.getResearchRecorder().recordDecision({
        recordId: `decision:${candidate.id}`,
        tokenMint: mint,
        mint,
        decision: 'REJECT',
        reason,
        rejectionReason: logEvent,
        stage: logEvent,
        candidateId: candidate.id,
        ...context,
        recordedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn('RESEARCH_RECORD_DECISION_FAILED', {
        candidateId: candidate.id,
        decision: 'REJECT',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Best-effort: forward rejection telemetry to the local API for
    // debugging. Signed — the API rejects unsigned /internal writes, since
    // this feeds the operator's dashboard.
    if (this.telemetrySink) {
      void this.telemetrySink.post('/internal/telemetry', {
        event: logEvent,
        candidateId: candidate.id,
        reason,
        context,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private safeFailCandidate(candidate: Candidate, reason: string): void {
    try {
      this.candidateManager.transition(candidate, 'FAILED', reason);
    } catch (error) {
      logger.error('CANDIDATE_FAILURE_TRANSITION_FAILED', {
        candidateId: candidate.id,
        reason,
        error: this.toErrorMessage(error),
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}