/**
 * Research metrics: empirical edge analysis across price lifecycle stages.
 *
 * For every discovered token, we record observation/signal/qualification/execution
 * lifecycle events, then measure post-entry performance from each reference price
 * across standard measurement windows (1s, 5s, 10s, 30s, 60s, 5m, 15m, 30m).
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
 * Lifecycle stages for a single token opportunity.
 *
 * These are NOT trading decisions — they are observation events in the
 * discovery → qualification → execution pipeline.
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
 * Research record: complete lifecycle + performance metrics for one token.
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
