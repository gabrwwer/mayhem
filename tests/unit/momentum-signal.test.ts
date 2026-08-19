/**
 * Entry-signal arithmetic — STRATEGY.md §3.3 / §3.4.
 *
 * These thresholds are unvalidated against market data, so the arithmetic is the
 * only part that can be verified today. It is verified exhaustively here.
 */

import { describe, expect, it } from 'vitest';
import {
  computeSignalMetrics,
  evaluateSignal,
  validateSamples,
  validateThresholds,
  type PriceSample,
  type SignalThresholds,
} from '../../apps/bot/src/momentum-signal';

/** Build a series from prices at a fixed cadence. */
function series(prices: number[], intervalMs = 2_000): PriceSample[] {
  const base = 1_700_000_000_000;
  return prices.map((price, i) => ({ price, timestamp: base + i * intervalMs }));
}

const PERMISSIVE: SignalThresholds = {
  minSamples: 2,
  minBuyPressure: 0,
  minNetFlowPct: -Infinity,
  maxVolatility: Infinity,
  maxDrawdownPct: Infinity,
  maxFlatRatio: 1,
};

const DEFAULT: SignalThresholds = {
  minSamples: 10,
  minBuyPressure: 0.65,
  minNetFlowPct: 2,
  maxVolatility: 0.5,
  maxDrawdownPct: 10,
  maxFlatRatio: 0.8,
};

describe('validateSamples', () => {
  it('rejects an empty series', () => {
    expect(validateSamples([])).toBe('no samples');
  });

  it('rejects a non-positive price', () => {
    expect(validateSamples(series([1, 0, 2]))).toMatch(/non-positive/);
    expect(validateSamples(series([1, -5]))).toMatch(/non-positive/);
  });

  it('rejects a non-finite price', () => {
    expect(validateSamples(series([1, NaN]))).toMatch(/non-positive|non-finite/);
    expect(validateSamples(series([1, Infinity]))).toMatch(/non-positive|non-finite/);
  });

  it('rejects out-of-order timestamps rather than silently sorting', () => {
    const samples: PriceSample[] = [
      { price: 1, timestamp: 2_000 },
      { price: 2, timestamp: 1_000 },
    ];
    expect(validateSamples(samples)).toMatch(/precedes/);
  });

  it('accepts a well-formed series', () => {
    expect(validateSamples(series([1, 2, 3]))).toBeNull();
  });
});

describe('computeSignalMetrics', () => {
  it('returns null for fewer than two samples', () => {
    expect(computeSignalMetrics(series([1]))).toBeNull();
    expect(computeSignalMetrics([])).toBeNull();
  });

  it('returns null when the series spans no time', () => {
    const samples: PriceSample[] = [
      { price: 1, timestamp: 5_000 },
      { price: 2, timestamp: 5_000 },
    ];
    expect(computeSignalMetrics(samples)).toBeNull();
  });

  it('computes buy pressure as the share of non-flat intervals that rose', () => {
    // deltas: +1 +1 -1 +1  → 3 up of 4 moved
    const m = computeSignalMetrics(series([10, 11, 12, 11, 12]))!;
    expect(m.buyPressure).toBeCloseTo(0.75, 10);
    expect(m.flatIntervals).toBe(0);
  });

  it('excludes flat intervals from the buy-pressure denominator', () => {
    // deltas: +1 0 0 -1 → 1 up of 2 moved, 2 flat
    const m = computeSignalMetrics(series([10, 11, 11, 11, 10]))!;
    expect(m.buyPressure).toBeCloseTo(0.5, 10);
    expect(m.flatIntervals).toBe(2);
  });

  /*
   * Regression: the previous implementation used `current >= previous`, scoring
   * a totally stalled curve as a perfect up-tick ratio. A dead token was the
   * most attractive thing the filter could see.
   */
  it('scores a completely flat curve as zero buy pressure, not one', () => {
    const m = computeSignalMetrics(series([10, 10, 10, 10, 10]))!;
    expect(m.buyPressure).toBe(0);
    expect(m.flatIntervals).toBe(4);
    expect(m.netFlowPct).toBe(0);
  });

  it('scores a monotonically rising curve as full buy pressure', () => {
    const m = computeSignalMetrics(series([1, 2, 3, 4]))!;
    expect(m.buyPressure).toBe(1);
  });

  it('scores a monotonically falling curve as zero buy pressure', () => {
    const m = computeSignalMetrics(series([4, 3, 2, 1]))!;
    expect(m.buyPressure).toBe(0);
  });

  it('computes net flow as total percentage change', () => {
    const m = computeSignalMetrics(series([100, 110]))!;
    expect(m.netFlowPct).toBeCloseTo(10, 10);
  });

  it('normalises flow rate per minute', () => {
    // 10% over two 30s intervals = 60s = 10%/min
    const m = computeSignalMetrics(series([100, 105, 110], 30_000))!;
    expect(m.elapsedMs).toBe(60_000);
    expect(m.flowRatePerMin).toBeCloseTo(10, 10);
  });

  it('reports drawdown from the running peak, not from the start', () => {
    // peak 120, ends 90 → 25% retracement
    const m = computeSignalMetrics(series([100, 120, 90]))!;
    expect(m.maxDrawdownPct).toBeCloseTo(25, 10);
  });

  it('reports zero drawdown for a monotonic rise', () => {
    expect(computeSignalMetrics(series([1, 2, 3]))!.maxDrawdownPct).toBe(0);
  });

  it('reports zero volatility for a constant-ratio series', () => {
    // Each step is exactly ×2, so every log return is identical.
    const m = computeSignalMetrics(series([1, 2, 4, 8]))!;
    expect(m.volatility).toBeCloseTo(0, 10);
  });

  it('reports higher volatility for an erratic series than a smooth one', () => {
    const smooth = computeSignalMetrics(series([100, 101, 102, 103]))!;
    const erratic = computeSignalMetrics(series([100, 150, 80, 130]))!;
    expect(erratic.volatility).toBeGreaterThan(smooth.volatility);
  });

  it('never produces NaN for any well-formed series', () => {
    const cases = [
      [1, 1], [1, 2], [2, 1], [1, 1, 1], [5, 5, 10, 10],
      [0.000001, 0.000002], [1e12, 1e12 + 1],
    ];
    for (const prices of cases) {
      const m = computeSignalMetrics(series(prices))!;
      expect(m).not.toBeNull();
      for (const [key, value] of Object.entries(m)) {
        expect(Number.isNaN(value as number), `${key} was NaN for ${prices}`).toBe(false);
      }
    }
  });

  it('survives extreme but finite price ratios', () => {
    const m = computeSignalMetrics(series([1e-12, 1e-6]))!;
    expect(Number.isFinite(m.netFlowPct)).toBe(true);
    expect(Number.isFinite(m.volatility)).toBe(true);
  });
});

describe('evaluateSignal', () => {
  it('rejects a structurally invalid series with a null metric set', () => {
    const r = evaluateSignal(series([1, 0]), PERMISSIVE);
    expect(r.confirmed).toBe(false);
    expect(r.metrics).toBeNull();
  });

  it('rejects a series below the minimum sample count', () => {
    const r = evaluateSignal(series([1, 2, 3]), DEFAULT);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toMatch(/insufficient samples: 3\/10/);
  });

  it('confirms a clean rising series', () => {
    const rising = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const r = evaluateSignal(series(rising), DEFAULT);
    expect(r.confirmed).toBe(true);
    expect(r.reason).toBe('signal confirmed');
    expect(r.metrics!.buyPressure).toBe(1);
  });

  /*
   * Regression: magnitude-weighted buy pressure divides by total movement, so
   * a curve that sits flat and then takes one buy scores a perfect 1.0 —
   * maximum confidence from a single observation. The activity floor must
   * catch this before any demand metric is trusted.
   */
  it('rejects a stalled curve with one late buy as insufficient activity', () => {
    const stalled = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 103];
    const metrics = computeSignalMetrics(series(stalled))!;
    expect(metrics.flowBuyPressure).toBe(1);
    expect(metrics.netFlowPct).toBeCloseTo(3, 10);

    const r = evaluateSignal(series(stalled), DEFAULT);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toMatch(/insufficient trading activity/);
    expect(r.reason).toMatch(/9\/10/);
  });

  it('admits an actively traded rise that clears the activity floor', () => {
    const active = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const r = evaluateSignal(series(active), DEFAULT);
    expect(r.confirmed).toBe(true);
  });

  it('rejects on low flow buy pressure when activity is sufficient', () => {
    // Many small ups absorbed by one large sell: count says healthy, flow does not.
    const absorbed = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 80];
    const metrics = computeSignalMetrics(series(absorbed))!;
    expect(metrics.buyPressure).toBeCloseTo(0.9, 10);
    expect(metrics.flowBuyPressure).toBeLessThan(0.5);

    const r = evaluateSignal(series(absorbed), DEFAULT);
    expect(r.confirmed).toBe(false);
  });

  it('rejects on insufficient net flow even at full buy pressure', () => {
    const crawl = [100, 100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7, 100.8, 100.9, 101];
    const r = evaluateSignal(series(crawl), DEFAULT);
    expect(r.confirmed).toBe(false);
    expect(r.metrics!.buyPressure).toBe(1);
    expect(r.reason).toMatch(/net flow/);
  });

  it('rejects on excess volatility', () => {
    const r = evaluateSignal(
      series([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]),
      { ...DEFAULT, maxVolatility: 0.000001 },
    );
    expect(r.confirmed).toBe(false);
    expect(r.reason).toMatch(/volatility/);
  });

  it('rejects on excess drawdown', () => {
    const spike = [100, 130, 128, 126, 124, 122, 120, 118, 116, 114, 112];
    const r = evaluateSignal(series(spike), DEFAULT);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toMatch(/drawdown/);
  });

  it('returns metrics alongside a rejection so tuning has data', () => {
    const r = evaluateSignal(series([4, 3, 2, 1]), { ...DEFAULT, minSamples: 2 });
    expect(r.confirmed).toBe(false);
    expect(r.metrics).not.toBeNull();
    expect(r.metrics!.buyPressure).toBe(0);
  });

  it('rejects a falling series under every reasonable threshold set', () => {
    const falling = [110, 108, 106, 104, 102, 100, 98, 96, 94, 92, 90];
    expect(evaluateSignal(series(falling), DEFAULT).confirmed).toBe(false);
  });

  /*
   * The permissive set is what a fully-disabled filter looks like. It must still
   * refuse a dead curve, because buy pressure of a stalled series is 0 and 0 is
   * not >= 0... except it is. This asserts the documented behaviour explicitly
   * so nobody "fixes" the flat-interval rule by accident.
   */
  it('admits a flat curve only when buy pressure is not required at all', () => {
    const r = evaluateSignal(series([10, 10, 10]), PERMISSIVE);
    expect(r.metrics!.buyPressure).toBe(0);
    expect(r.confirmed).toBe(true);
  });
});

describe('validateThresholds', () => {
  it('accepts the documented default set', () => {
    expect(validateThresholds(DEFAULT)).toEqual([]);
  });

  it('rejects buy pressure outside 0..1', () => {
    expect(validateThresholds({ ...DEFAULT, minBuyPressure: 1.5 })).toHaveLength(1);
    expect(validateThresholds({ ...DEFAULT, minBuyPressure: -0.1 })).toHaveLength(1);
  });

  it('rejects a sample floor below two', () => {
    expect(validateThresholds({ ...DEFAULT, minSamples: 1 })).toHaveLength(1);
    expect(validateThresholds({ ...DEFAULT, minSamples: 2.5 })).toHaveLength(1);
  });

  it('rejects a non-positive volatility ceiling', () => {
    expect(validateThresholds({ ...DEFAULT, maxVolatility: 0 })).toHaveLength(1);
  });

  it('rejects a negative drawdown ceiling', () => {
    expect(validateThresholds({ ...DEFAULT, maxDrawdownPct: -1 })).toHaveLength(1);
  });

  it('rejects a flat ratio outside 0..1', () => {
    expect(validateThresholds({ ...DEFAULT, maxFlatRatio: 1.5 })).toHaveLength(1);
    expect(validateThresholds({ ...DEFAULT, maxFlatRatio: -0.1 })).toHaveLength(1);
  });

  it('accumulates multiple problems', () => {
    expect(
      validateThresholds({
        minSamples: 0,
        minBuyPressure: 2,
        minNetFlowPct: NaN,
        maxVolatility: -1,
        maxDrawdownPct: -1,
        maxFlatRatio: 2,
      }),
    ).toHaveLength(6);
  });
});
