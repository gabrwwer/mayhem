import { SlotSchema, TimestampSchema, type Slot, type Timestamp } from '@mayhem/core-types';
import { describe, expect, it } from 'vitest';

import { assessLpHealth, type LpHealthThresholds } from './health.js';
import { computeLiquidityChange } from './events.js';
import { estimated, observed, unavailable } from './provenance.js';

const NOW: Timestamp = TimestampSchema.parse(1_700_000_000_000);
const SLOT: Slot = SlotSchema.parse(500);
const SOURCE = 'test';

const THRESHOLDS: LpHealthThresholds = {
  watchDeclinePct: 10,
  degradedDeclinePct: 25,
  criticalDeclinePct: 50,
  removedAtOrBelow: 0.01,
};

function obs(value: number) {
  return observed(value, { slot: SLOT, observedAt: NOW, source: SOURCE });
}

function assess(current: number | null, initial: number | null) {
  return assessLpHealth({
    currentLiquidity:
      current === null ? unavailable<number>({ observedAt: NOW, source: SOURCE }) : obs(current),
    initialLiquidity:
      initial === null ? null : obs(initial),
    thresholds: THRESHOLDS,
    assessedAt: NOW,
  });
}

describe('assessLpHealth()', () => {
  it('reports UNKNOWN when current liquidity was not observed', () => {
    const health = assess(null, 100);

    expect(health.status).toBe('UNKNOWN');
    expect(health.reasons).toContain('NO_OBSERVATION');
    // Critically, an unread pool is not reported as drained.
    expect(health.removed).toBe(false);
    expect(health.degraded).toBe(false);
  });

  it('reports UNKNOWN, not HEALTHY, when there is no baseline', () => {
    const health = assess(100, null);

    expect(health.status).toBe('UNKNOWN');
    expect(health.reasons).toContain('NO_BASELINE');
  });

  it('refuses an estimated current reading', () => {
    const health = assessLpHealth({
      currentLiquidity: estimated(100, { observedAt: NOW, source: SOURCE }),
      initialLiquidity: obs(100),
      thresholds: THRESHOLDS,
      assessedAt: NOW,
    });

    expect(health.status).toBe('UNKNOWN');
    expect(health.reasons).toContain('NO_OBSERVATION');
  });

  it('refuses an estimated baseline', () => {
    const health = assessLpHealth({
      currentLiquidity: obs(100),
      initialLiquidity: estimated(100, { observedAt: NOW, source: SOURCE }),
      thresholds: THRESHOLDS,
      assessedAt: NOW,
    });

    expect(health.status).toBe('UNKNOWN');
    expect(health.reasons).toContain('NO_BASELINE');
  });

  it('classifies an effectively empty pool as removed even with no baseline', () => {
    const health = assess(0, null);

    expect(health.status).toBe('CRITICAL');
    expect(health.removed).toBe(true);
    expect(health.reasons).toContain('LIQUIDITY_EFFECTIVELY_REMOVED');
  });

  it('reports growth as HEALTHY', () => {
    const health = assess(120, 100);

    expect(health.status).toBe('HEALTHY');
    expect(health.liquidityChangePct).toBeCloseTo(20);
    expect(health.degraded).toBe(false);
  });

  it('reports a small decline as STABLE', () => {
    const health = assess(95, 100);

    expect(health.status).toBe('STABLE');
    expect(health.liquidityChangePct).toBeCloseTo(-5);
  });

  it('reports a 10% decline as WATCH at the boundary', () => {
    const health = assess(90, 100);
    expect(health.status).toBe('WATCH');
  });

  it('reports a 25% decline as DEGRADED at the boundary', () => {
    const health = assess(75, 100);

    expect(health.status).toBe('DEGRADED');
    expect(health.degraded).toBe(true);
    expect(health.removed).toBe(false);
  });

  it('reports a 50% decline as CRITICAL at the boundary', () => {
    const health = assess(50, 100);

    expect(health.status).toBe('CRITICAL');
    expect(health.degraded).toBe(true);
  });

  it('does not mark a severe decline as removed while reserves remain', () => {
    const health = assess(5, 100);

    expect(health.status).toBe('CRITICAL');
    expect(health.removed).toBe(false);
  });
});

describe('computeLiquidityChange()', () => {
  it('computes delta and percentage for two observations', () => {
    const change = computeLiquidityChange(obs(100), obs(75));

    expect(change.delta).toBe(-25);
    expect(change.changePct).toBeCloseTo(-25);
  });

  it('returns nulls when the new reading is unavailable', () => {
    // A failed RPC call must not manufacture a -100% rug alert.
    const change = computeLiquidityChange(
      obs(100),
      unavailable<number>({ observedAt: NOW, source: SOURCE }),
    );

    expect(change.delta).toBeNull();
    expect(change.changePct).toBeNull();
  });

  it('returns nulls when either side is an estimate', () => {
    const change = computeLiquidityChange(
      estimated(100, { observedAt: NOW, source: SOURCE }),
      obs(75),
    );

    expect(change.delta).toBeNull();
    expect(change.changePct).toBeNull();
  });

  it('returns nulls when there is no previous reading', () => {
    const change = computeLiquidityChange(null, obs(75));

    expect(change.delta).toBeNull();
    expect(change.changePct).toBeNull();
  });

  it('reports delta but no percentage when the baseline is zero', () => {
    const change = computeLiquidityChange(obs(0), obs(10));

    expect(change.delta).toBe(10);
    expect(change.changePct).toBeNull();
  });
});
