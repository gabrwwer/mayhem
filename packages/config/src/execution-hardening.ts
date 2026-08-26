/**
 * Mayhem Execution Hardening Configuration
 *
 * This configuration intentionally keeps live trading disabled.
 *
 * Architecture:
 *
 * DISCOVERY
 *   -> HARD SAFETY
 *   -> QUALIFICATION
 *   -> ENTRY QUALITY
 *   -> POSITION SIZE
 *   -> EXECUTION PRECHECK
 *   -> BOUNDED EXECUTION
 *   -> FILL VERIFICATION
 *   -> POSITION MANAGEMENT
 *   -> RECONCILIATION
 */

export const EXECUTION_HARDENING = {
  mode: "HARDENED",

  /**
   * Safety
   */
  safety: {
    requireTradingEnabled: true,
    requireExecutableVenue: true,
    requireFreshQuote: true,
    requireHealthyRpc: true,
    requirePositionCapacity: true,
    requireRiskBudget: true,
    requireLiquidityCheck: true,
    requireFlowCheck: true,
    requireMomentumCheck: true,
  },

  /**
   * Entry qualification.
   *
   * Qualification and entry are deliberately separate decisions.
   */
  qualification: {
    minimumEntryScore: 70,

    scoreBands: {
      reduced: {
        minimum: 70,
        maximum: 84,
        sizeMultiplier: 0.25,
      },

      normal: {
        minimum: 85,
        maximum: 94,
        sizeMultiplier: 0.50,
      },

      strong: {
        minimum: 95,
        maximum: 100,
        sizeMultiplier: 0.75,
      },
    },

    /**
     * No trade when the token is already excessively extended.
     */
    overextension: {
      enabled: true,
      maximumPriceExtensionPct: 25,
      maximumMomentumAccelerationPct: 100,
    },

    /**
     * Contract/token safety remains a hard gate.
     */
    tokenSafety: {
      rejectActiveMintAuthority: true,
      rejectFreezeAuthorityWhenRequired: true,
    },
  },

  /**
   * Entry score.
   *
   * These weights must total 1.00.
   */
  entryScore: {
    momentumWeight: 0.25,
    flowWeight: 0.20,
    liquidityWeight: 0.15,
    volumeWeight: 0.15,
    holderDistributionWeight: 0.10,
    executionWeight: 0.10,
    tokenSafetyWeight: 0.05,

    minimumScore: 70,
  },

  /**
   * Position sizing.
   *
   * Dynamic sizing replaces the concept of a universal fixed opening size.
   */
  positionSizing: {
    enabled: true,

    /**
     * Conservative base risk budget.
     * This is NOT a live authorization.
     */
    baseRiskBudgetSol: 0.05,

    minimumPositionSol: 0.005,
    maximumPositionSol: 0.05,

    /**
     * Hard portfolio limits.
     */
    maximumConcurrentPositions: 3,
    maximumTotalExposureSol: 0.15,

    /**
     * Signal quality multipliers.
     */
    confidenceMultipliers: {
      reduced: 0.25,
      normal: 0.50,
      strong: 0.75,
      exceptional: 1.00,
    },

    /**
     * Execution quality can only reduce size.
     */
    executionQuality: {
      excellent: 1.00,
      good: 0.85,
      acceptable: 0.60,
      poor: 0.25,
      rejected: 0.00,
    },

    /**
     * Never increase size because price is moving faster.
     */
    momentumSizeCeiling: 1.00,
    momentumCannotOverrideExecution: true,

    /**
     * Absolute caps.
     */
    hardCap: {
      maximumPositionSol: 0.05,
      maximumExposureSol: 0.15,
    },
  },

  /**
   * Two-stage entry.
   *
   * The second allocation is a new decision.
   */
  stagedEntry: {
    enabled: true,

    initialAllocationPct: 60,
    confirmationAllocationPct: 40,

    requireSecondDecision: true,
    requireFillVerification: true,
    requireThesisStillValid: true,
    requireLiquidityStillHealthy: true,
    requireFlowStillHealthy: true,
    requireExecutionStillHealthy: true,

    neverAddOnlyBecausePriceIncreased: true,
  },

  /**
   * Execution preflight.
   */
  execution: {
    requirePreflight: true,

    maximumSlippagePct: 8,
    targetMaximumSlippagePct: 5,

    maximumEntryPriceImpactBps: 750,
    maximumQuoteAgeMs: 750,

    /**
     * Do not chase a deteriorating quote.
     */
    cancelIfPriceExceedsMaximum: true,
    cancelIfSlippageExceedsMaximum: true,
    cancelIfQuoteExpired: true,

    /**
     * Bounded retries.
     */
    maximumAttempts: 3,
    retryDelayMs: 500,

    /**
     * Transaction deadline.
     */
    executionDeadlineMs: 3000,

    /**
     * Priority fee must be bounded.
     */
    priorityFee: {
      enabled: true,
      maximumLamports: 500000,
    },

    /**
     * Total transaction cost ceiling.
     */
    maximumTotalFeeSol: 0.005,
  },

  /**
   * Fill verification.
   */
  fillVerification: {
    enabled: true,
    required: true,

    verifyActualInput: true,
    verifyActualOutput: true,
    verifyAverageFillPrice: true,
    verifyActualSlippage: true,
    verifyFees: true,
    verifyTransactionConfirmation: true,

    /**
     * If the actual position no longer satisfies the thesis,
     * do not silently retain it.
     */
    reevaluateAfterFill: true,
    exitIfThesisInvalidAfterFill: true,
  },

  /**
   * Initial risk protection.
   */
  risk: {
    stopLossPct: 15,

    /**
     * Existing no-averaging-down policy remains mandatory.
     */
    allowAveragingDown: false,

    /**
     * Emergency exits.
     */
    emergencyExit: {
      liquidityCollapse: true,
      abnormalSellPressure: true,
      executionFailure: true,
      transactionInconsistency: true,
      rpcStateInconsistency: true,
      tradingHalt: true,
      contractRisk: true,
    },

    /**
     * Risk governor.
     */
    maximumDailyLossSol: 0.15,
    maximumConsecutiveLosses: 5,

    lockoutAfterDailyLoss: true,
    lockoutAfterConsecutiveLosses: true,
  },

  /**
   * Profit-lock / partial exits.
   */
  profitLock: {
    enabled: true,

    ladder: [
      {
        triggerPct: 20,
        sellPct: 25,
      },
      {
        triggerPct: 40,
        sellPct: 25,
      },
      {
        triggerPct: 75,
        sellPct: 20,
      },
    ],

    /**
     * Remaining position becomes runner.
     */
    runnerPctTarget: 30,

    /**
     * Lock can only move upward.
     */
    stopCanOnlyMoveUp: true,
    neverLoosenStop: true,
  },

  /**
   * Momentum-aware runner.
   */
  momentumExit: {
    enabled: true,

    /**
     * Momentum deterioration causes progressive exits.
     */
    partialExitOnMomentumDeterioration: true,
    aggressiveExitOnMomentumReversal: true,

    /**
     * Liquidity deterioration overrides momentum.
     */
    liquidityDeteriorationOverridesMomentum: true,
  },

  /**
   * Volatility-aware trailing.
   */
  volatilityTrail: {
    enabled: true,

    minimumTrailPct: 8,
    maximumTrailPct: 30,

    /**
     * Higher realized volatility permits a wider trail.
     */
    highVolatilityWiderTrail: true,
    lowVolatilityTighterTrail: true,

    neverWidenAfterProfitLock: false,
  },

  /**
   * Reconciliation.
   *
   * Blockchain state is authoritative.
   */
  reconciliation: {
    enabled: true,
    blockchainIsSourceOfTruth: true,

    reconcileAfterEntry: true,
    reconcileAfterPartialExit: true,
    reconcileAfterFullExit: true,
    reconcileAfterRestart: true,

    freezeNewEntriesOnMismatch: true,

    requireActualBalanceMatch: true,
    requireActualTransactionMatch: true,
  },

  /**
   * Explicit no-trade conditions.
   */
  noTrade: {
    insufficientLiquidity: true,
    unstableLiquidity: true,
    excessiveSlippage: true,
    suspiciousVolume: true,
    abnormalFlow: true,
    excessiveWalletConcentration: true,
    exhaustedMomentum: true,
    excessiveExecutionLatency: true,
    unhealthyRpc: true,
    excessiveFees: true,
    positionLimitReached: true,
    dailyRiskLimitReached: true,
    consecutiveLossLockout: true,
    reconciliationMismatch: true,
  },

  /**
   * Research remains enabled regardless of trading mode.
   */
  research: {
    recordQualification: true,
    recordEntryScore: true,
    recordPositionSizeDecision: true,
    recordExecutionPreflight: true,
    recordFillVerification: true,
    recordExitDecision: true,
    recordReconciliation: true,
    recordRejectedTrades: true,
  },

  /**
   * CRITICAL:
   * Keep live trading disabled until replay/backtest validation passes.
   */
  liveSafety: {
    dryRun: true,
    tradingEnabled: false,
    requireExplicitLiveEnable: true,
  },
} as const;

export type ExecutionHardeningConfig = typeof EXECUTION_HARDENING;
