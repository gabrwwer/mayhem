/**
 * Entry signal computation — STRATEGY.md §3.3.
 *
 * Pure functions over a series of price samples. No I/O, no clock, no config
 * lookup: everything needed is passed in. That is deliberate — the previous
 * implementation lived inside a 150-line private method that interleaved
 * sampling with evaluation, so the decision rule could not be tested without a
 * live RPC connection. Every threshold in this file is unvalidated
 * (STRATEGY.md §0), which makes cheap, exhaustive testing of the *arithmetic*
 * the only thing standing between a bad number and a bad trade.
 *
 * On a pump.fun bonding curve price is `virtualSolReserves / virtualTokenReserves`
 * and reserves move only when someone trades. A price delta between two samples
 * is therefore net order flow over that interval, and the share of intervals
 * with positive flow ("buy pressure") measures sustained demand in a way a
 * single start-to-end percentage change cannot.
 */

export interface PriceSample {
  /** Price in the caller's units. Must be finite and > 0. */
  price: number;
  /** Epoch milliseconds. Must be non-decreasing across the series. */
  timestamp: number;
}

export interface SignalThresholds {
  /** Minimum samples before any signal is emitted. */
  minSamples: number;
  /** Minimum share of non-flat intervals that were up. Range 0..1. */
  minBuyPressure: number;
  /** Minimum total price change across the window, percent. */
  minNetFlowPct: number;
  /** Maximum stdev of log returns. Rejects curves too erratic to price. */
  maxVolatility: number;
  /** Maximum retracement from the window peak, percent. */
  maxDrawdownPct: number;
  /**
   * Maximum share of intervals with no price movement. Range 0..1.
   *
   * An activity floor, and it is load-bearing. Magnitude-weighted buy pressure
   * divides by total movement, so a curve that sits flat and then receives one
   * buy scores 1.0 — perfect confidence from a single observation. Live data
   * showed this is the common case, not an edge case: most launches trade two
   * to four times per minute, which cannot support any inference about demand.
   *
   * "Too illiquid to evaluate" is a distinct finding from "falling", and
   * conflating them hides how much of the universe is simply untradeable.
   */
  maxFlatRatio: number;
}

export interface SignalMetrics {
  samples: number;
  /** count(delta > 0) / count(delta != 0). Diagnostic only — see flowBuyPressure. */
  buyPressure: number;
  /**
   * Share of total absolute price movement that was upward, by magnitude:
   * `sum(max(r,0)) / sum(|r|)` over relative returns r. Range 0..1.
   *
   * This is the gating metric. Counting intervals weights a +0.1% tick and a
   * -13% dump equally, which live data showed is not a hypothetical concern:
   * a token logged buyPressure 0.857 (6 of 7 moves up) while losing 11.8%,
   * because the curve grinds upward in small increments and drops in large
   * ones. Magnitude weighting scores that token near 0.13 and rejects it.
   *
   * Relative rather than absolute deltas, so the measure is scale-free and
   * comparable across tokens priced orders of magnitude apart.
   */
  flowBuyPressure: number;
  /** (last - first) / first, percent. */
  netFlowPct: number;
  /** netFlowPct normalised per minute, for comparison across window lengths. */
  flowRatePerMin: number;
  /** Sample standard deviation of log returns. */
  volatility: number;
  /** Maximum observed retracement from running peak, percent. Diagnostic only. */
  maxDrawdownPct: number;
  /**
   * Distance of the FINAL price below the window peak, percent. Gating metric.
   *
   * Max drawdown is a permanent black mark for ancient history: a token that
   * dipped 17% at second 10 and climbed steadily afterwards scores identically
   * to one that peaked at second 50 and is collapsing. At entry only the
   * second case matters, because that is the one being bought into.
   *
   * Live data forced this distinction. Observed in a single 60s window: a
   * token ended +165% while sitting 84% below its peak (it ran ~+1500% and
   * retraced), and another ended +6.1% carrying a 17% max drawdown. The first
   * is genuinely collapsing; the second may be mid-recovery. One number could
   * not tell them apart.
   */
  finalDrawdownPct: number;
  finalPrice: number;
  elapsedMs: number;
  /** Intervals where price did not move. High values mean a dead curve. */
  flatIntervals: number;
}

export interface SignalResult {
  confirmed: boolean;
  /** Null only when the sample series was structurally unusable. */
  metrics: SignalMetrics | null;
  reason: string;
}

/** Structural validity of a sample series. Separated so failures are specific. */
export function validateSamples(samples: readonly PriceSample[]): string | null {
  if (samples.length === 0) return 'no samples';

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    if (!Number.isFinite(s.price) || s.price <= 0) {
      return `sample ${i} has non-positive or non-finite price`;
    }
    if (!Number.isFinite(s.timestamp)) {
      return `sample ${i} has non-finite timestamp`;
    }
    if (i > 0 && s.timestamp < samples[i - 1]!.timestamp) {
      // Out-of-order samples would corrupt the elapsed-time denominator and
      // silently distort flowRatePerMin. Reject rather than sort: the ordering
      // failure itself indicates something wrong upstream.
      return `sample ${i} timestamp precedes its predecessor`;
    }
  }

  return null;
}

/**
 * Compute metrics over a validated sample series.
 *
 * Returns null when the series cannot support metrics (fewer than two samples,
 * or zero elapsed time). Callers must treat null as "no signal", never as
 * "signal absent therefore fine".
 */
export function computeSignalMetrics(
  samples: readonly PriceSample[],
): SignalMetrics | null {
  if (validateSamples(samples) !== null) return null;
  if (samples.length < 2) return null;

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const elapsedMs = last.timestamp - first.timestamp;
  if (elapsedMs <= 0) return null;

  let upIntervals = 0;
  let flatIntervals = 0;
  let movedIntervals = 0;
  let peakPrice = first.price;
  let maxDrawdownPct = 0;
  let upMagnitude = 0;
  let totalMagnitude = 0;

  const logReturns: number[] = [];

  for (let i = 1; i < samples.length; i += 1) {
    const current = samples[i]!;
    const previous = samples[i - 1]!;
    const delta = current.price - previous.price;

    /*
     * A flat interval is not an up interval.
     *
     * The prior implementation used `current >= previous`, which scored a
     * completely stalled curve as 100% up-ticks — the single most permissive
     * possible reading of a token nobody is trading. Flat intervals are
     * excluded from the denominator entirely: they are absence of evidence,
     * not evidence of demand.
     */
    if (delta > 0) {
      upIntervals += 1;
      movedIntervals += 1;
    } else if (delta < 0) {
      movedIntervals += 1;
    } else {
      flatIntervals += 1;
    }

    logReturns.push(Math.log(current.price / previous.price));

    // Relative move, so magnitudes are comparable across price scales.
    const relative = delta / previous.price;
    if (relative > 0) upMagnitude += relative;
    totalMagnitude += Math.abs(relative);

    peakPrice = Math.max(peakPrice, current.price);
    const drawdownPct = ((peakPrice - current.price) / peakPrice) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  }

  /*
   * No interval moved at all: the curve is dead. Buy pressure is 0, not NaN and
   * not 1. Returning 0 makes a dead curve fail the minimum-buy-pressure check
   * on the same code path as a falling one, which is the correct treatment.
   */
  const buyPressure = movedIntervals === 0 ? 0 : upIntervals / movedIntervals;

  const netFlowPct = ((last.price - first.price) / first.price) * 100;
  const elapsedMinutes = elapsedMs / 60_000;
  const flowRatePerMin = netFlowPct / elapsedMinutes;

  /*
   * A curve with no movement at all has no buying, so 0 rather than NaN — the
   * same treatment as count-based buyPressure, and for the same reason: a dead
   * token must fail on the ordinary rejection path, not produce a NaN that
   * silently compares false against every threshold.
   */
  const flowBuyPressure = totalMagnitude === 0 ? 0 : upMagnitude / totalMagnitude;

  // Where the window ended relative to its high-water mark.
  const finalDrawdownPct = ((peakPrice - last.price) / peakPrice) * 100;

  return {
    samples: samples.length,
    buyPressure,
    flowBuyPressure,
    finalDrawdownPct,
    netFlowPct,
    flowRatePerMin,
    volatility: sampleStdev(logReturns),
    maxDrawdownPct,
    finalPrice: last.price,
    elapsedMs,
    flatIntervals,
  };
}

/**
 * Apply entry thresholds — STRATEGY.md §3.4.
 *
 * All conditions must hold. Checks are ordered so the returned reason names the
 * most diagnostic failure: structural problems first, then the demand signal,
 * then the quality filters. Rejection reasons are logged and drive tuning, so a
 * vague reason has a real cost.
 */
export function evaluateSignal(
  samples: readonly PriceSample[],
  thresholds: SignalThresholds,
): SignalResult {
  const structuralError = validateSamples(samples);
  if (structuralError !== null) {
    return { confirmed: false, metrics: null, reason: structuralError };
  }

  if (samples.length < thresholds.minSamples) {
    return {
      confirmed: false,
      metrics: computeSignalMetrics(samples),
      reason: `insufficient samples: ${samples.length}/${thresholds.minSamples}`,
    };
  }

  const metrics = computeSignalMetrics(samples);
  if (metrics === null) {
    return { confirmed: false, metrics: null, reason: 'sample series spans no time' };
  }

  /*
   * Activity floor first: every metric below is computed from intervals that
   * moved, so if almost nothing moved they are inferences from one or two
   * observations dressed up as statistics. Reject before that happens, and say
   * why plainly.
   */
  const intervals = metrics.samples - 1;
  const flatRatio = intervals > 0 ? metrics.flatIntervals / intervals : 1;

  if (flatRatio > thresholds.maxFlatRatio) {
    return {
      confirmed: false,
      metrics,
      reason:
        `insufficient trading activity: ${metrics.flatIntervals}/${intervals} ` +
        `intervals flat (${(flatRatio * 100).toFixed(0)}%), ` +
        `limit ${(thresholds.maxFlatRatio * 100).toFixed(0)}%`,
    };
  }

  /*
   * Gate on magnitude-weighted flow, not interval counts.
   *
   * The flat-aware count ratio is retained below for diagnostics, but it
   * cannot distinguish "many small buys, one large sell" from genuine demand,
   * and live observation showed that is the common case rather than an edge
   * case. Magnitude weighting asks the question that actually matters: what
   * share of the SOL that moved through this curve was buying?
   */
  const demandBuyPressure = metrics.flowBuyPressure;
  const countBuyPressure = getFlatAwareBuyPressure(samples);

  /*
   * Gate on where the window ENDED relative to its peak, not on the worst dip
   * it ever saw. Buying is a decision about the present: a token recovering
   * from an early dip is a different asset from one collapsing off a recent
   * high, and max drawdown scores them the same.
   */
  if (metrics.finalDrawdownPct > thresholds.maxDrawdownPct) {
    return {
      confirmed: false,
      metrics,
      reason:
        `final drawdown ${metrics.finalDrawdownPct.toFixed(2)}% ` +
        `(max ${metrics.maxDrawdownPct.toFixed(2)}%) exceeds ` +
        `${thresholds.maxDrawdownPct}%`,
    };
  }

  if (metrics.volatility > thresholds.maxVolatility) {
    return {
      confirmed: false,
      metrics,
      reason: `volatility ${metrics.volatility.toFixed(4)} exceeds ${thresholds.maxVolatility}`,
    };
  }

  if (metrics.netFlowPct < thresholds.minNetFlowPct) {
    return {
      confirmed: false,
      metrics,
      reason: `net flow ${metrics.netFlowPct.toFixed(2)}% below ${thresholds.minNetFlowPct}%`,
    };
  }

  if (demandBuyPressure < thresholds.minBuyPressure) {
    return {
      confirmed: false,
      metrics,
      reason:
        `flow buy pressure ${demandBuyPressure.toFixed(3)} ` +
        `(count ${countBuyPressure.toFixed(2)}) below ` +
        `${thresholds.minBuyPressure} (${metrics.flatIntervals} flat intervals)`,
    };
  }

  return { confirmed: true, metrics, reason: 'signal confirmed' };
}

/**
 * Validate a threshold set at construction time.
 *
 * A misconfigured threshold (negative minimum, buy pressure above 1) yields a
 * rule that can never pass or never reject. Both fail silently at runtime — the
 * bot simply stops trading, or stops filtering. Returns a list of problems;
 * empty means usable.
 */
export function validateThresholds(t: SignalThresholds): string[] {
  const problems: string[] = [];

  if (!Number.isInteger(t.minSamples) || t.minSamples < 2) {
    problems.push('minSamples must be an integer >= 2');
  }
  if (!Number.isFinite(t.minBuyPressure) || t.minBuyPressure < 0 || t.minBuyPressure > 1) {
    problems.push('minBuyPressure must be within 0..1');
  }
  if (!Number.isFinite(t.minNetFlowPct)) {
    problems.push('minNetFlowPct must be finite');
  }
  if (!Number.isFinite(t.maxVolatility) || t.maxVolatility <= 0) {
    problems.push('maxVolatility must be > 0');
  }
  if (!Number.isFinite(t.maxDrawdownPct) || t.maxDrawdownPct < 0) {
    problems.push('maxDrawdownPct must be >= 0');
  }
  if (!Number.isFinite(t.maxFlatRatio) || t.maxFlatRatio < 0 || t.maxFlatRatio > 1) {
    problems.push('maxFlatRatio must be within 0..1');
  }

  return problems;
}

/**
 * Buy pressure should account for flat intervals as non-buying periods, while the
 * exported metrics keep the moved-only ratio for diagnostics.
 */
function getFlatAwareBuyPressure(samples: readonly PriceSample[]): number {
  if (samples.length < 2) return 0;

  let upIntervals = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]!.price > samples[i - 1]!.price) {
      upIntervals += 1;
    }
  }

  return upIntervals / (samples.length - 1);
}

/** Sample standard deviation (n-1). Returns 0 for fewer than two values. */
function sampleStdev(values: readonly number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);

  return Math.sqrt(variance);
}
