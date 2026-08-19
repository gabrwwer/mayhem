import { TimestampSchema, type Timestamp } from '@mayhem/core-types';
import { describe, expect, it } from 'vitest';

import {
  EntryEligibilitySchema,
  evaluateEntryEligibility,
  explainReason,
} from './eligibility.js';

const NOW: Timestamp = TimestampSchema.parse(1_700_000_000_000);

function evaluate(overrides: Partial<Parameters<typeof evaluateEntryEligibility>[0]> = {}) {
  return evaluateEntryEligibility({
    lifecycleState: 'TRADEABLE',
    lpHealth: 'HEALTHY',
    hasInitialSnapshot: true,
    requireInitialSnapshot: true,
    evaluatedAt: NOW,
    ...overrides,
  });
}

describe('evaluateEntryEligibility()', () => {
  it('is eligible only when nothing objects', () => {
    const result = evaluate();

    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.explanations).toHaveLength(0);
  });

  it('blocks a pre-LP token as not initialized', () => {
    const result = evaluate({ lifecycleState: 'PRE_LP' });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('POOL_NOT_INITIALIZED');
  });

  it('blocks a merely-detected pool', () => {
    // Detection is not tradeability.
    const result = evaluate({ lifecycleState: 'LP_DETECTED' });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('POOL_NOT_INITIALIZED');
  });

  it('blocks an initialized but unvalidated pool', () => {
    const result = evaluate({ lifecycleState: 'LP_INITIALIZED' });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('POOL_NOT_TRADEABLE');
  });

  it('treats UNKNOWN liquidity as a blocker, never as safe', () => {
    const result = evaluate({ lpHealth: 'UNKNOWN' });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('LP_STATE_UNKNOWN');
  });

  it('blocks on degraded liquidity', () => {
    const result = evaluate({ lpHealth: 'DEGRADED' });

    expect(result.reasons).toContain('LIQUIDITY_UNSTABLE');
  });

  it('blocks on critical liquidity', () => {
    const result = evaluate({ lpHealth: 'CRITICAL' });

    expect(result.reasons).toContain('LIQUIDITY_REMOVED');
  });

  it('permits WATCH health on its own', () => {
    const result = evaluate({ lpHealth: 'WATCH' });

    expect(result.eligible).toBe(true);
  });

  it('blocks a missing initial snapshot only when required', () => {
    const required = evaluate({ hasInitialSnapshot: false, requireInitialSnapshot: true });
    expect(required.reasons).toContain('INITIAL_SNAPSHOT_MISSING');

    const optional = evaluate({ hasInitialSnapshot: false, requireInitialSnapshot: false });
    expect(optional.eligible).toBe(true);
  });

  it('merges externally supplied reason codes', () => {
    const result = evaluate({
      externalReasons: ['TOKEN_AUTHORITY_RISK', 'RISK_LIMIT_REACHED'],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['TOKEN_AUTHORITY_RISK', 'RISK_LIMIT_REACHED']),
    );
  });

  it('de-duplicates a reason produced by two sources', () => {
    // LIQUIDITY_REMOVED can arrive from both lifecycle and health.
    const result = evaluate({
      lifecycleState: 'LIQUIDITY_REMOVED',
      lpHealth: 'CRITICAL',
    });

    const removed = result.reasons.filter((r) => r === 'LIQUIDITY_REMOVED');
    expect(removed).toHaveLength(1);
  });

  it('emits exactly one explanation per reason, in order', () => {
    const result = evaluate({ lifecycleState: 'PRE_LP', lpHealth: 'UNKNOWN' });

    expect(result.explanations).toHaveLength(result.reasons.length);
    result.reasons.forEach((reason, index) => {
      expect(result.explanations[index]).toBe(explainReason(reason));
    });
  });

  it('produces a value satisfying the schema invariants', () => {
    expect(EntryEligibilitySchema.safeParse(evaluate()).success).toBe(true);
    expect(
      EntryEligibilitySchema.safeParse(evaluate({ lifecycleState: 'PRE_LP' })).success,
    ).toBe(true);
  });
});

describe('EntryEligibilitySchema', () => {
  it('rejects an eligible verdict that carries reasons', () => {
    const result = EntryEligibilitySchema.safeParse({
      eligible: true,
      reasons: ['LIQUIDITY_TOO_LOW'],
      explanations: ['too low'],
      lifecycleState: 'TRADEABLE',
      lpHealth: 'HEALTHY',
      evaluatedAt: NOW,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a block with no stated reason', () => {
    const result = EntryEligibilitySchema.safeParse({
      eligible: false,
      reasons: [],
      explanations: [],
      lifecycleState: 'TRADEABLE',
      lpHealth: 'HEALTHY',
      evaluatedAt: NOW,
    });

    expect(result.success).toBe(false);
  });
});
