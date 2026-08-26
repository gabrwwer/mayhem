/**
 * Research metrics: empirical edge analysis across price lifecycle stages.
 *
 * For every discovered token, we record observation/signal/qualification/execution
 * lifecycle events, then measure post-entry performance from each reference price
 * across standard measurement windows (1s, 5s, 10s, 30s, 60s, 5m, 15m, 30m).
 *
 * Enhanced for comprehensive tokenomics and taxonomy research.
 *
 * Purpose: determine which lifecycle price produces the best edge without
 * modifying trading logic or enabling live execution.
 */

export const MEASUREMENT_WINDOWS_MS = [
  1_000,      // 1 second
  5_000,      // 5 seconds
  10_000,     // 10 seconds
  30_000,     // 30 seconds
  60_000,     // 60 seconds
  5 * 60_000, // 5 minutes
  15 * 60_000, // 15 minutes
  30 * 60_000, // 30 minutes
];

/**
 * Enhanced lifecycle stages for a single token opportunity.
 *
 * These are NOT trading decisions — they are observation events in the
 * discovery → qualification → execution pipeline and beyond.
 */
export interface PriceLifecycleEvent {
  /** When the token was discovered/observed on-chain. */
  observationTime: number;
  observationPrice: number;

  /** When the token passed qualification filters. */
  signalTime: number;
  signalPrice: number;

  /** When the entry threshold was met and the trade was qualified. */
  qualificationTime: number;
  qualifiedEntryPrice: number;

  /** When the transaction was actually executed (filled). */
  executionTime?: number;
  executionPrice?: number;

  /** LP initialization data (when available) */
  lpInitializationTime?: number;
  lpInitializationLiquiditySol?: number;
  lpInitializationLiquidityUsd?: number;

  /** Graduation/migration data (when detectable) */
  graduationTime?: number;
  graduationSignature?: string;
  preGraduationLiquiditySol?: number;
  postGraduationLiquiditySol?: number;
  preGraduationVolumeSol?: number;
  postGraduationVolumeSol?: number;

  /** Staleness detection */
  lastTradeAt?: number;
  lastMeaningfulVolumeAt?: number;
  lastPriceChangeAt?: number;
  lastLiquidityChangeAt?: number;
  lastMomentumAt?: number;
  staleClassification?: 'ACTIVE' | 'COOLING' | 'STALE' | 'DEAD';
  staleReason?: string;
}

/**
 * LP Initialization and Liquidity Data
 */
export interface LiquidityEvent {
  lpCreatedAt: number;
  lpInitializedAt: number;
  initialLiquiditySol: number;
  initialLiquidityUsd: number;
  initialBaseReserve: number;
  initialQuoteReserve: number;
  baseReserve: number;
  quoteReserve: number;
  liquidityUsd: number;
  liquidityChange: number;
  liquidityChangePct: number;
  lpGrowthPct: number;
  lpWithdrawalPct: number;
  lpAdditionEvents: number;
  lpRemovalEvents: number;
  lpProviderCount: number;
  poolAge: number;
  poolAddress: string;
  dex: string;
  poolType: string;
  liquidityClassification:
    | 'LIQUIDITY_BUILDING'
    | 'LIQUIDITY_STABLE'
    | 'LIQUIDITY_GROWING'
    | 'LIQUIDITY_DECLINING'
    | 'LIQUIDITY_WITHDRAWING'
    | 'LIQUIDITY_CRITICAL';
}

/**
 * Volume Taxonomy Data
 */
export interface VolumeData {
  volume1m: number;
  volume5m: number;
  volume15m: number;
  volume30m: number;
  volume1h: number;
  volumeSinceLaunch: number;

  buyVolume: number;
  sellVolume: number;
  buyVolumePct: number;
  sellVolumePct: number;

  baselineVolume1m: number;
  baselineVolume5m: number;
  baselineVolume15m: number;
  baselineVolume30m: number;
  baselineVolume1h: number;

  volumeMultiplier1m: number;
  volumeMultiplier5m: number;
  volumeMultiplier15m: number;

  volumeAcceleration: number;
  volumeDeceleration: number;
  volumeSurge: boolean;
  volumeCollapse: boolean;

  volumeRank: number;
  volumePercentile: number;
  volumeZScore: number;

  volumeSurgeTiming: 'BEFORE_PRICE_MOVE' | 'DURING_PRICE_MOVE' | 'AFTER_PRICE_MOVE' | null;
}

/**
 * Buy/Sell Pressure Data
 */
export interface PressureData {
  buyCount: number;
  sellCount: number;
  buyVolume: number;
  sellVolume: number;
  buyPressure: number;
  sellPressure: number;
  buySellRatio: number;
  flowBuyPressure: number;
  netFlow: number;
  netFlowPct: number;
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;

  // Over time windows
  buyCount1m: number;
  sellCount1m: number;
  buyVolume1m: number;
  sellVolume1m: number;
  buyCount5m: number;
  sellCount5m: number;
  buyVolume5m: number;
  sellVolume5m: number;
  buyCount15m: number;
  sellCount15m: number;
  buyVolume15m: number;
  sellVolume15m: number;

  // Pressure trends
  buyPressureIncreasing: boolean;
  buyPressureDecreasing: boolean;
  sellPressureIncreasing: boolean;
  sellPressureIncreasingDuringPriceRise: boolean;
  sellPressureIncreasingDuringPriceDecline: boolean;
}

/**
 * Trade Flow Data
 */
export interface TradeFlowData {
  tradeCount: number;
  uniqueTraders: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  largeBuyCount: number;
  largeSellCount: number;
  largeBuyVolume: number;
  largeSellVolume: number;
  medianTradeSize: number;
  meanTradeSize: number;
  largestTrade: number;
  tradeSizeDistribution: Record<string, number>; // e.g., {"0-0.01": 5, "0.01-0.1": 10, ...}

  // Flow classification
  flowClassification:
    | 'retail_dominated'
    | 'whale_dominated'
    | 'mixed_flow'
    | 'low_activity'
    | 'high_activity';
}

/**
 * Volatility Measures
 */
export interface VolatilityData {
  realizedVolatility: number; // standard deviation of returns
  rollingVolatility: number;
  volatility1m: number;
  volatility5m: number;
  volatility15m: number;

  // ATR-like measures
  atr: number;
  atrPct: number;

  // Range measures
  highLowRange: number;
  rangePct: number;
  candleBodyPct: number;
  wickPct: number;
  upperWickPct: number;
  lowerWickPct: number;

  // Volatility state
  volatilityExpansion: boolean;
  volatilityCompression: boolean;
  volatilityBreakout: boolean;
  volatilityCollapse: boolean;
}

/**
 * Enhanced Momentum Taxonomy
 *
 * Multi-state momentum rather than simple boolean
 */
export interface MomentumData {
  /** Multi-state momentum */
  momentumState:
    | 'NO_MOMENTUM'
    | 'EARLY_MOMENTUM'
    | 'ACCELERATING'
    | 'STRONG'
    | 'CONFIRMED'
    | 'EXTREME'
    | 'EXHAUSTING'
    | 'REVERSING'
    | 'FAILED';

  momentumScore: number; // 0-100 composite score
  momentumConfidence: number; // 0-100 confidence in momentum state
  growthPerMin: number;
  priceVelocity: number;
  priceAcceleration: number;
  volumeAcceleration: number;
  netFlowAcceleration: number;
  buyPressureAcceleration: number;

  // Momentum drivers
  momentumDrivenBy:
    | 'PRICE_LED'
    | 'VOLUME_LED'
    | 'FLOW_LED'
    | 'LIQUIDITY_LED'
    | 'MIXED'
    | 'UNKNOWN';

  // Components (0-100 scale)
  priceMomentumComponent: number;
  volumeMomentumComponent: number;
  flowMomentumComponent: number;
  volatilityComponent: number; // inverted - lower volatility = higher score
}

/**
 * Trend Structure Analysis
 */
export interface TrendData {
  vwap: number;
  priceVsVwap: number; // percentage
  vwapSlope: number; // rate of change

  // Trend by timeframe
  trend1m: 'UPTREND' | 'WEAK_UPTREND' | 'SIDEWAYS' | 'WEAK_DOWNTREND' | 'DOWNTREND';
  trend5m: 'UPTREND' | 'WEAK_UPTREND' | 'SIDEWAYS' | 'WEAK_DOWNTREND' | 'DOWNTREND';
  trend15m: 'UPTREND' | 'WEAK_UPTREND' | 'SIDEWAYS' | 'WEAK_DOWNTREND' | 'DOWNTREND';
  trend30m: 'UPTREND' | 'WEAK_UPTREND' | 'SIDEWAYS' | 'WEAK_DOWNTREND' | 'DOWNTREND';
  trend1h: 'UPTREND' | 'WEAK_UPTREND' | 'SIDEWAYS' | 'WEAK_DOWNTREND' | 'DOWNTREND';

  // Swing points
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: number;

  // Trend strength
  trendStrength: number; // 0-100
  trendConsistency: number; // 0-100
}

/**
 * Pullback/Support/Continuation Analysis
 */
export interface PullbackSupportData {
  // Impulse wave metrics
  impulseMagnitude: number; // % move from start to peak
  impulseDuration: number; // milliseconds

  // Pullback metrics
  pullbackPct: number; // % retracement from peak
  pullbackDuration: number; // milliseconds
  pullbackClassification: 'HEALTHY' | 'EXCESSIVE' | 'FAILED';

  // Support testing
  supportPrice: number;
  supportDistancePct: number; // % from current price to support
  supportTests: number; // number of times support tested
  supportHeld: boolean;

  // Recovery/continuation
  recoverySpeed: number; // % recovered per minute
  confirmationVolume: number; // volume on confirmation bar
  confirmationBuyPressure: number; // buy pressure on confirmation
  continuationProbability: number; // 0-100 likelihood of continuation

  // Breakout detection
  breakoutDetected: boolean;
  breakoutVolume: number;
  breakoutStrength: number; // 0-100
}

/**
 * Holder/Wallet Taxonomy
 */
export interface HolderWalletData {
  holderCount: number;
  holderGrowth: number; // % change over period
  newHolderRate: number; // new holders per hour
  holderConcentration: number; // Gini coefficient or similar
  top10Pct: number; // % held by top 10 holders
  top20Pct: number; // % held by top 20 holders
  creatorOwnershipPct: number;
  developerOwnershipPct: number;
  largestHolderPct: number;

  // Wallet behavior
  newBuyerWallets: number;
  newSellerWallets: number;
  repeatBuyerRate: number; // % of buys from wallets that bought before
  repeatSellerRate: number; // % of sells from wallets that sold before
  walletRetention: number; // % of wallets that continue trading
  walletChurn: number; // % of wallets that stop trading

  // Developer/creator activity
  creatorSellVolume: number;
  creatorBuyVolume: number;
  creatorTransfers: number;
  creatorLPActivity: number; // LP add/remove actions

  // Holder distribution classification
  holderClassification:
    | 'HEALTHY_DISTRIBUTION'
    | 'CONCENTRATED'
    | 'DEV_HEAVY'
    | 'EARLY_DISTRIBUTION'
    | 'UNKNOWN';
}

/**
 * Token Metadata
 */
export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  metadataUri: string | null;
  metadataHash: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  socialLinks: Record<string, string>;
  creator: string | null;
  launchPlatform: string | null;
  creationTimestamp: number | null;

  // Metadata change tracking
  metadataChanged: boolean;
  metadataChangeTime: number | null;
  metadataChangeType: 'NAME' | 'SYMBOL' | 'DESCRIPTION' | 'URI' | 'SOCIAL' | null;
}

/**
 * Launch Platform Specifics
 */
export interface LaunchPlatformData {
  launchPlatform: string; // pump.fun, Raydium, Orca, Jupiter-routed, etc.
  launchMechanism: string; // bonding curve, direct pool, etc.
  venue: string; // specific DEX or launchpad
  dex: string; // DEX program ID
  programId: string; // on-chain program that launched it
  bondingCurveAddress: string | null; // for pump.fun style launches
  bondingCurveProgram: string | null;
}

/**
 * Graduation/Migration Events
 */
export interface GraduationData {
  graduationDetected: boolean;
  graduationAt: number | null;
  graduationSignature: string | null;
  preGraduationLiquiditySol: number;
  postGraduationLiquiditySol: number;
  preGraduationVolumeSol: number;
  postGraduationVolumeSol: number;
  priceChangeAroundGraduation: number; // % price change around graduation time
  volumeChangeAroundGraduation: number; // % volume change around graduation time
  liquidityChangeAroundGraduation: number; // % liquidity change around graduation time

  // Graduation outcome classification
  graduationClassification:
    | 'GRADUATION_SUCCESS'
    | 'GRADUATION_WEAK'
    | 'GRADUATION_FAILURE'
    | 'UNKNOWN';

  // Migration data (if applicable)
  migrationAddress: string | null;
  migrationSignature: string | null;
}

/**
 * Execution Simulation Data (for DRY_RUN)
 */
export interface ExecutionSimulation {
  entrySignal: string; // what triggered the entry
  entryPrice: number;
  entryTimestamp: number;
  positionSizeSol: number;
  positionSizeUsd: number;
  simulatedFillPrice: number;
  expectedPrice: number;
  simulatedSlippage: number; // bps
  priceImpact: number; // bps
  estimatedFees: number; // SOL
  estimatedPriorityFee: number; // SOL
  estimatedJitoTip: number; // SOL
  totalEstimatedCost: number; // SOL

  // Execution quality
  executionMode: 'DRY_RUN' | 'LIVE';
  executionResult: 'FILLED' | 'PARTIAL' | 'FAILED' | 'UNAVAILABLE';

  // If partially filled
  fillPercentage: number; // 0-100

  // Timing
  timeToFill: number | null; // milliseconds to complete fill
}

/**
 * Position Simulation Data
 *
 * Tracks hypothetical position performance for research
 */
export interface PositionSimulation {
  positionId: string;
  tokenMint: string;
  entryTime: number;
  entryPrice: number;
  positionSize: number; // in SOL
  notional: number; // position size in token units
  fees: number; // entry fees in SOL

  // Excursion metrics
  highWaterMark: number; // highest price reached
  maxFavorableExcursion: number; // % gain from entry to peak
  maxAdverseExcursion: number; // % loss from entry to trough

  // P&L tracking
  currentPnL: number; // SOL
  realizedPnL: number; // SOL (if position closed)
  unrealizedPnL: number; // SOL (if position open)

  // Threshold achievement tracking
  thresholdAchievement: Record<
    string,
    'REACHED' | 'NOT_REACHED' | 'REACHED_THEN_REVERSED'
  >; // e.g., {"+1%": "REACHED", "+5%": "REACHED_THEN_REVERSED"}

  // Threshold timing
  timeToThreshold: Record<string, number | null>; // milliseconds to reach each threshold

  // Drawdown analysis
  maxDrawdown: number; // % drawdown from peak to trough
  timeToPeak: number; // milliseconds to reach peak price
  peakPrice: number;
}

/**
 * Take-Profit Research Data
 *
 * Data for evaluating TP ladder effectiveness
 */
export interface TakeProfitResearch {
  mfe: number; // maximum favorable excursion %
  mae: number; // maximum adverse excursion %
  timeToMfe: number; // milliseconds to reach MFE
  timeToMae: number; // milliseconds to reach MAE

  // Timing to profit thresholds
  timeToProfitThreshold: Record<string, number | null>; // e.g., {"+4%": 120000, "+7%": 300000}
  timeFromThresholdToPeak: Record<string, number | null>; // e.g., {"+4%": 60000}
  drawdownAfterThreshold: Record<string, number | null>; // e.g., {"+4%": 5.2} % drawdown after hitting threshold

  // Simulated TP ladder outcomes (what *would* have happened)
  simulatedTpOutcomes: Record<string, {
    exitedAtThreshold: boolean;
    exitPrice: number;
    exitTime: number;
    pnlSol: number;
    pnlPercent: number;
  }>;
}

/**
 * Stop-Loss/Trailing Stop Research Data
 */
export interface StopLossResearch {
  // Test various stop strategies
  stopTests: Record<string, {
    stopType: 'FIXED' | 'ATR' | 'VWAP' | 'STRUCTURE' | 'MOMENTUM_FAILURE' | 'LIQUIDITY_WITHDRAWAL' | 'TRAILING_PERCENTAGE';
    stopValue: number; // e.g., 8 for 8% stop, or ATR multiplier
    triggered: boolean;
    triggerPrice: number;
    triggerTime: number;
    pnlAtStop: number; // SOL
    maxDrawdownBeforeTrigger: number; // %
    drawdownAfterTrigger: number; // %
    timeSpentUnderwaterBeforeTrigger: number; // milliseconds
    recoveryProbability: number; // 0-100 chance of recovery if not stopped
    stoppedBeforeRecovery: boolean;
    stoppedAfterMomentumFailure: boolean;
  }>;

  // Optimal stop analysis
  optimalStopDistance: number; // % that minimizes useless stop-outs
  optimalStopType: 'FIXED' | 'ATR' | 'VWAP' | 'STRUCTURE' | 'MOMENTUM_FAILURE' | 'LIQUIDITY_WITHDRAWAL' | 'TRAILING_PERCENTAGE';
}

/**
 * Liquidity/Execution Risk Analysis
 */
export interface LiquidityExecutionRisk {
  liquidityToPositionSizeRatio: number; // liquiditySol / positionSizeSol
  estimatedEntryImpactBps: number; // basis points
  estimatedExitImpactBps: number; // basis points
  estimatedRoundTripImpactBps: number; // basis points
  estimatedFeesSol: number;
  estimatedTotalFrictionBps: number; // fees + impact

  // Execution quality classification
  executionQuality: 'EXECUTION_ACCEPTABLE' | 'EXECUTION_MARGINAL' | 'EXECUTION_UNACCEPTABLE';

  // Risk thresholds (these would be configurable/hypothetical)
  maxEntryImpactBps: number; // e.g., 75
  maxExitImpactBps: number; // e.g., 150
  maxTotalFrictionBps: number; // e.g., 225
};

/**
 * Passing Candidate Snapshot - captured when token passes risk+momentum gates
 */
export interface PassingCandidateSnapshot {
  tokenMint: string;
  timestamp: number; // Unix timestamp in milliseconds

  // Core price and liquidity data
  price: number;
  liquiditySol: number;
  depthSol: number; // bonding curve depth or pool reserve

  // Risk and momentum scores
  riskScore: number;
  momentumConfirmed: boolean;

  // Market data at decision point
  volume24h: number;
  volumeChange5m: number; // % change
  buyPressure: number; // 0-1
  sellPressure: number; // 0-1
  flowBuyPressure: number; // magnitude-weighted

  // Holder data
  holderCount: number;
  holderGrowth1h: number; // % change

  // Trade flow
  tradeCount: number;
  uniqueTraders: number;
  uniqueBuyers: number;
  uniqueSellers: number;

  // Volatility
  volatility: number; // realized volatility
  priceChange5m: number; // % change

  // Quote data
  quoteAgeMs: number;
  priceImpactBps: number;

  // Additional context
  source: string; // discovery source
  isPumpFun: boolean;

  /** Exact observed quote price approximately 5 seconds after candidate pass. */
  price5s?: number;

  /** Exact observed quote price approximately 15 seconds after candidate pass. */
  price15s?: number;

  /** Exact observed quote price approximately 30 seconds after candidate pass. */
  price30s?: number;

  /** Exact observed quote price approximately 60 seconds after candidate pass. */
  price60s?: number;

  /** Maximum favorable excursion during the observation window, percent. */
  mfePct?: number;

  /** Maximum adverse excursion during the observation window, percent. */
  maePct?: number;

  /** Final price change from the passing snapshot to the 60-second observation, percent. */
  finalPriceChangePct?: number;
}

/**
 * Forward Observation Data - captured at specific intervals after passing candidate detection
 */
export interface ForwardObservation {
  tokenMint: string;
  observationTime: number; // Unix timestamp when observation was taken
  delayMs: number; // milliseconds since passing candidate detection

  // Price metrics
  price: number;
  priceChangePct: number; // % change from snapshot price

  // Excursion metrics (MFE/MAE) for the observation window
  mfePct: number; // max favorable excursion %
  maePct: number; // max adverse excursion %

  // Volume metrics
  volumeChangePct: number; // % change from snapshot volume

  // Holder metrics
  holderCount: number;
  holderChangePct: number; // % change from snapshot

  // Pressure metrics
  buyPressure: number; // 0-1
  sellPressure: number; // 0-1;
  flowBuyPressure: number; // magnitude-weighted

  // Liquidity and depth
  liquiditySol: number;
  depthSol: number;

  // Quote data
  quoteAgeMs: number;
  priceImpactBps: number;

  // Volatility
  volatility: number; // realized volatility during observation window
}

/**
 * Aggregated Passing Candidate Outcome - combines snapshot with all forward observations
 */
export interface PassingCandidateOutcome {
  snapshot: PassingCandidateSnapshot;
  observations: ForwardObservation[]; // ordered by delayMs

  // Summary metrics
  maxPriceGainPct: number; // maximum price gain observed
  maxPriceLossPct: number; // maximum price loss observed
  finalPriceChangePct: number; // price change at last observation

  // Success metrics
  reachedProfitTarget: boolean; // if price ever reached +X% during observation
  hitStopLoss: boolean; // if price ever dropped -Y% during observation
}

/**
 * Enhanced Research Record with comprehensive data
 */
export interface EnhancedResearchRecord {
  recordId: string;
  schemaVersion: number;
  recordedAt: string; // ISO timestamp

  // Core identification
  tokenMint: string;

  // Record type discrimination
  recordType:
    | 'DISCOVERY'
    | 'OBSERVATION'
    | 'DECISION'
    | 'EXECUTION'
    | 'OUTCOME'
    | 'LP_INITIALIZATION'
    | 'LIQUIDITY_EVENT'
    | 'MOMENTUM_EVENT'
    | 'GRADUATION'
    | 'METADATA_UPDATE'
    | 'STALE_EVENT'
    | 'POSITION_SIMULATION'
    | 'TAKE_PROFIT_RESEARCH'
    | 'STOP_LOSS_RESEARCH'
    | 'LIQUIDITY_EXECUTION_RISK'
    | 'EXIT_DECISION'
    | 'PASSING_CANDIDATE_FORWARD_OUTCOME'
    | 'PASSING_CANDIDATE_OUTCOME';

  // Event-specific data (union-like pattern)
  event?: string; // e.g., 'TOKEN_DISCOVERED', 'MOMENTUM_EVALUATION', 'BUY_DECISION', etc.

  // Token identity and metadata (populated in DISCOVERY and updated in METADATA_UPDATE)
  tokenIdentity?: {
    mintAddress: string;
    tokenMint: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    totalSupply: number | null;
    circulatingSupply: number | null;
    creatorWallet: string | null;
    deployerWallet: string | null;
    developerWallet: string | null;
    creationSignature: string | null;
    launchSignature: string | null;
    poolAddress: string | null;
    lpAddress: string | null;
    marketAddress: string | null;
    baseMint: string | null;
    quoteMint: string | null;
    dex: string | null;
    venue: string | null;
    programId: string | null;
    launchPlatform: string | null;
    source: string | null;
    firstSeenAt: number | null;
    createdAt: number | null;
    launchAt: number | null;
    lpInitializedAt: number | null;
    graduationAt: number | null;
    lastSeenAt: number | null;
    bondingCurveAddress: string | null;
    bondingCurveProgram: string | null;
    migrationAddress: string | null;
    migrationSignature: string | null;
    graduationStatus: string | null; // e.g., 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'FAILED'
  };

  // Lifecycle progression (built over time)
  lifecycle?: PriceLifecycleEvent;

  // Rich observation data (sampled over time)
  observationData?: {
    timestamp: number;
    price: number;
    priceSol: number;
    priceUsd: number;

    // OHLCV for the sampling period
    open: number;
    high: number;
    low: number;
    close: number;

    // Volume taxonomy
    volumeData?: VolumeData;

    // Buy/sell pressure
    pressureData?: PressureData;

    // Trade flow
    tradeFlowData?: TradeFlowData;

    // Volatility measures
    volatilityData?: VolatilityData;

    // Momentum taxonomy
    momentumData?: MomentumData;

    // Trend structure
    trendData?: TrendData;

    // Pullback/support/continuation
    pullbackSupportData?: PullbackSupportData;

    // Holder/wallet taxonomy
    holderWalletData?: HolderWalletData;

    // Token metadata
    metadata?: TokenMetadata;

    // Launch platform specifics
    launchPlatformData?: LaunchPlatformData;

    // Liquidity event data
    liquidityEvent?: LiquidityEvent;

    // Graduation data
    graduationData?: GraduationData;

    // Staleness data (could also be in lifecycle)
    staleClassification?: 'ACTIVE' | 'COOLING' | 'STALE' | 'DEAD';
    staleReason?: string;

    // Execution quality and simulation
    executionSimulation?: ExecutionSimulation;

    // Price relative to various references
    distanceFromVwapPct?: number;
    distanceFromLaunchPricePct?: number;
    distanceFromInitialPricePct?: number;
    distanceFromAthPct?: number;
    distanceFromAtlPct?: number;
  };

  // Decision data (when a decision is made)
  decisionData?: {
    decision: 'BUY' | 'REJECT' | 'QUALIFIED' | 'SIMULATED_ENTRY' | 'SIMULATED_EXIT' | 'STALE' | 'EXIT' | 'UNKNOWN';
    reason: string;
    rejectionReason?: string; // for REJECT decisions

    // Comprehensive scoring (0-100 scale) - null when not measured
    momentumScore?: number | null;
    volumeScore?: number | null;
    liquidityScore?: number | null;
    trendScore?: number | null;
    flowScore?: number | null;
    executionScore?: number | null;
    overallScore?: number | null;

    // Risk breakdown - null when not measured
    riskScore?: number | null;
    riskComponents?: {
      liquidityRisk?: number | null;
      volumeRisk?: number | null;
      momentumRisk?: number | null;
      holderRisk?: number | null;
      volatilityRisk?: number | null;
      executionRisk?: number | null;
    } | null;

    // Context at decision time
    priceAtDecision: number;
    liquidityAtDecision?: number | null;
    volumeAtDecision?: number | null;
    holderCountAtDecision?: number | null;

    // Exit-specific data (for EXIT decisions)
    exitReason?: string; // stop_loss, take_profit, trailing_stop, time_exit, liquidity_exit, volatility_exit, emergency
    stopLossThreshold?: number | null;
    takeProfitThreshold?: number | null;
    trailingStopThreshold?: number | null;
    maxHoldThreshold?: number | null;

    // Entry-specific data (for BUY decisions)
    entrySignal?: string;
    entrySignalStrength?: number | null;

    // Additional decision context
    netFlowPct?: number | null;
    priceChangePct?: number | null;
    transactionVelocity?: number | null;
    uniqueBuyers?: number | null;
    uniqueSellers?: number | null;
    largestBuySol?: number | null;
    largestSellSol?: number | null;
    topBuyerConcentration?: number | null;
    buyVolumeSol?: number | null;
    sellVolumeSol?: number | null;
    buySellVolumeRatio?: number | null;
    curveProgressPct?: number | null;
    poolLiquidity?: number | null;
    curveDepthSol?: number | null;
    curveReserveSol?: number | null;
    buyerGrowthScore?: number | null; // Only use when actually measured
  };

  // Execution data (simulated or actual)
  executionData?: {
    // For simulated executions in DRY_RUN
    executionSimulation?: ExecutionSimulation;

    // For actual executions
    signature: string | null;
    requestedAmount: number;
    executedAmount: number | null;
    requestedPrice: number;
    executedPrice: number | null;
    slippageBps: number | null;
    slippagePercent: number | null;
    fees: number;
    timestamp: string; // ISO timestamp
    executionStatus: 'CONFIRMED' | 'FAILED' | 'PARTIAL' | 'EXPIRED' | 'PENDING';

    // Failure reasons
    failureReason?: string;
    failureStatus?: string;
  };

  // Complete lifecycle and position data (when position closes)
  lifecycleComplete?: {
    lifecycle: PriceLifecycleEvent;
    positionOpened: boolean;
    positionId: string | null;

    // Price history for performance calculation
    priceHistory: Array<{ timestamp: number; price: number }>;

    // Performance measured from each lifecycle reference price
    performanceFromObservationPrice: Record<string, PerformanceMeasurement>;
    performanceFromSignalPrice: Record<string, PerformanceMeasurement>;
    performanceFromQualifiedEntryPrice: Record<string, PerformanceMeasurement>;
    performanceFromExecutionPrice?: Record<string, PerformanceMeasurement> | undefined;

    // Slippage: difference between qualified and actual fill
    slippageBps: number | undefined;
    slippagePercent: number | undefined;

    // Position simulation data (if position was opened)
    positionSimulation?: PositionSimulation;

    // Take-profit research data
    takeProfitResearch?: TakeProfitResearch;

    // Stop-loss research data
    stopLossResearch?: StopLossResearch;

    // Liquidity/execution risk analysis
    liquidityExecutionRisk?: LiquidityExecutionRisk;

    // Configuration context
    config: {
      dryRun: boolean;
      tradingEnabled: boolean;
    };
  };

  // Outcome data (final result of position)
  outcomeData?: {
    positionId: string;
    entryTimestamp: string; // ISO
    exitTimestamp: string; // ISO
    entryPrice: number;
    exitPrice: number;

    quantity: number;
    entryNotionalSol: number;

    grossPnlSol: number;
    netPnlSol: number;
    netPnlPercent: number;
    feesSol: number;

    exitReason:
      | 'TP'
      | 'TRAIL'
      | 'STOP_LOSS'
      | 'VWAP_FAILURE'
      | 'MOMENTUM_FAILURE'
      | 'LIQUIDITY_WITHDRAWAL'
      | 'STALE'
      | 'MANUAL_SIMULATION_END'
      | 'UNKNOWN';

    // Excursion metrics
    maxFavorableExcursion: number; // %
    maxAdverseExcursion: number; // %
    maxDrawdown: number; // % from peak to trough
    peakPrice: number;
    timeToPeak: number; // milliseconds

    // Hold time
    holdDurationMs: number;

    // Configuration
    config: {
      dryRun: boolean;
      tradingEnabled: boolean;
    };
  };

  // Simulated position data (for hypothetical positions that never entered)
  positionSimulationData?: PositionSimulation;

  // Research-specific metrics
  researchMetrics: {
    // Data quality and completeness
    dataCompleteness: number; // 0-100% of expected fields populated
    observationCount: number; // how many observations recorded for this token
    daysTracked: number; // how long we've been tracking this token

    // Recording metadata
    recordedBy: string; // version or identifier of recording logic
    recordingSchema: number;
  };
}

/**
 * Legacy Research Record (maintained for backward compatibility)
 */
export interface ResearchRecord {
  recordId: string;
  tokenMint: string;
  recordedAt: string;

  /** The complete lifecycle event for this token. */
  lifecycle: PriceLifecycleEvent;

  /** Was this position actually opened in the engine? */
  positionOpened: boolean;
  positionId?: string | undefined;

  /** Post-entry price history used for metrics calculation. */
  priceHistory: Array<{ timestamp: number; price: number }>;

  /** Performance measured from each lifecycle price. */
  performanceFromObservationPrice: Record<string, PerformanceMeasurement>;
  performanceFromSignalPrice: Record<string, PerformanceMeasurement>;
  performanceFromQualifiedEntryPrice: Record<string, PerformanceMeasurement>;
  performanceFromExecutionPrice?: Record<string, PerformanceMeasurement> | undefined;

  /** Slippage: difference between qualified and actual fill. */
  slippageBps?: number | undefined;
  slippagePercent?: number | undefined;

  /** Configuration context */
  config: {
    dryRun: boolean;
    tradingEnabled: boolean;
  };
}

/**
 * Measurement at a single point in time for a given lifecycle reference price.
 */
export interface PerformanceMeasurement {
  windowMs: number;
  measurementTime: number;
  price: number;

  /** Return from the reference price */
  returnPercent: number;
  /** Max favorable excursion: highest price reached in the window */
  mfePercent: number;
  /** Max adverse excursion: lowest price reached in the window */
  maePercent: number;
  /** Max drawdown from peak in the window */
  maxDrawdownPercent: number;

  /** Time (ms) to reach +5%, or null if not reached in window */
  timeToPlus5Percent: number | null;
  /** Time (ms) to reach +10% */
  timeToPlus10Percent: number | null;
  /** Time (ms) to reach +25% */
  timeToPlus25Percent: number | null;
  /** Time (ms) to reach +50% */
  timeToPlus50Percent: number | null;
  /** Time (ms) to reach -5% */
  timeToMinus5Percent: number | null;
  /** Time (ms) to reach -10% */
  timeToMinus10Percent: number | null;
  /** Time (ms) to reach -20% */
  timeToMinus20Percent: number | null;
}

/**
 * Aggregate research statistics.
 */
export interface ResearchStatistics {
  totalTokensObserved: number;
  totalSignals: number;
  totalQualified: number;
  totalExecuted: number;
  executionRate: number;

  /** Performance statistics by lifecycle price. */
  observationPriceStats: PerformanceStats;
  signalPriceStats: PerformanceStats;
  qualifiedEntryStats: PerformanceStats;
  executionPriceStats: PerformanceStats;
}

export interface PerformanceStats {
  windowMs: number;
  count: number;
  avgReturnPercent: number;
  medianReturnPercent: number;
  stdDevReturnPercent: number;
  winRate: number;
  avgMfe: number;
  avgMae: number;
}
