import { SlotSchema, TimestampSchema, type Slot, type Timestamp } from '@mayhem/core-types';
import { describe, expect, it } from 'vitest';

import { allowedTransitions, canTransition, isTradeableState } from './lifecycle.js';
import { estimated, observed, unavailable } from './provenance.js';
import { LifecycleStateMachine } from './state-machine.js';

const NOW: Timestamp = TimestampSchema.parse(1_700_000_000_000);
const slot = (n: number): Slot => SlotSchema.parse(n);
const SOURCE = 'test';

function atPreLp(): LifecycleStateMachine {
  return LifecycleStateMachine.preLp({ observedAt: NOW, slot: slot(100) });
}

function atValidating(): LifecycleStateMachine {
  const m = atPreLp();
  m.apply({
    to: 'LP_DETECTED',
    reason: 'POOL_ACCOUNT_DETECTED',
    detail: 'pool account seen',
    observedAt: NOW,
    slot: slot(101),
  });
  m.apply({
    to: 'LP_INITIALIZED',
    reason: 'POOL_REPORTED_INITIALIZED',
    detail: 'venue reports initialized',
    observedAt: NOW,
    slot: slot(102),
  });
  m.apply({
    to: 'LIQUIDITY_VALIDATING',
    reason: 'RESERVES_OBSERVED',
    detail: 'reserves read',
    observedAt: NOW,
    slot: slot(103),
  });
  return m;
}

describe('transition table', () => {
  it('does not allow a detected pool to become tradeable', () => {
    // The safety property this whole module exists for.
    expect(canTransition('LP_DETECTED', 'TRADEABLE')).toBe(false);
    expect(allowedTransitions('LP_DETECTED').includes('TRADEABLE')).toBe(false);
  });

  it('does not allow an initialized pool to skip validation', () => {
    expect(canTransition('LP_INITIALIZED', 'TRADEABLE')).toBe(false);
  });

  it('only reaches TRADEABLE from LIQUIDITY_VALIDATING or LIQUIDITY_DEGRADED', () => {
    const states = [
      'PRE_LP',
      'LP_DETECTED',
      'LP_INITIALIZED',
      'LIQUIDITY_VALIDATING',
      'TRADEABLE',
      'LIQUIDITY_DEGRADED',
      'LIQUIDITY_REMOVED',
      'CLOSED',
    ] as const;

    const canReach = states.filter((s) => canTransition(s, 'TRADEABLE'));
    expect(canReach).toEqual(['LIQUIDITY_VALIDATING', 'LIQUIDITY_DEGRADED']);
  });

  it('treats CLOSED as terminal', () => {
    expect(allowedTransitions('CLOSED')).toHaveLength(0);
  });

  it('requires a drained pool to be re-validated, not restored directly', () => {
    expect(canTransition('LIQUIDITY_REMOVED', 'TRADEABLE')).toBe(false);
    expect(canTransition('LIQUIDITY_REMOVED', 'LIQUIDITY_VALIDATING')).toBe(true);
  });
});

describe('LifecycleStateMachine.apply()', () => {
  it('starts in PRE_LP with one history record', () => {
    const m = atPreLp();

    expect(m.state).toBe('PRE_LP');
    expect(m.history).toHaveLength(1);
    expect(m.latest.reason).toBe('TOKEN_DETECTED');
  });

  it('refuses an illegal transition without mutating state', () => {
    const m = atPreLp();
    const outcome = m.apply({
      to: 'TRADEABLE',
      reason: 'LIQUIDITY_VALIDATED',
      detail: 'attempted skip',
      observedAt: NOW,
      slot: slot(200),
    });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.rejection.code).toBe('ILLEGAL_TRANSITION');
    }
    expect(m.state).toBe('PRE_LP');
    expect(m.history).toHaveLength(1);
  });

  it('refuses any transition out of a terminal state', () => {
    const m = atPreLp();
    m.apply({
      to: 'CLOSED',
      reason: 'POOL_CLOSED_OBSERVED',
      detail: 'closed',
      observedAt: NOW,
      slot: slot(300),
    });

    const outcome = m.apply({
      to: 'LP_DETECTED',
      reason: 'POOL_ACCOUNT_DETECTED',
      detail: 'late event',
      observedAt: NOW,
      slot: slot(301),
    });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.rejection.code).toBe('TERMINAL_STATE');
    }
  });

  it('rejects an observation older than the recorded slot', () => {
    const m = atValidating();

    // A slow RPC response carrying pre-drain reserves must not rewrite history.
    const outcome = m.apply({
      to: 'TRADEABLE',
      reason: 'LIQUIDITY_VALIDATED',
      detail: 'stale reading',
      observedAt: NOW,
      slot: slot(50),
    });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.rejection.code).toBe('STALE_OBSERVATION');
    }
    expect(m.state).toBe('LIQUIDITY_VALIDATING');
  });

  it('accepts an observation at the same slot as the high-water mark', () => {
    const m = atValidating();
    const outcome = m.apply({
      to: 'TRADEABLE',
      reason: 'LIQUIDITY_VALIDATED',
      detail: 'same slot',
      observedAt: NOW,
      slot: slot(103),
    });

    expect(outcome.applied).toBe(true);
  });

  it('returns a defensive copy of history', () => {
    const m = atPreLp();
    const history = m.history as unknown as unknown[];
    history.push({});

    expect(m.history).toHaveLength(1);
  });
});

describe('LifecycleStateMachine.validate()', () => {
  it('promotes to TRADEABLE on an observed reading meeting the floor', () => {
    const m = atValidating();
    const outcome = m.validate({
      liquidity: observed(10, { slot: slot(104), observedAt: NOW, source: SOURCE }),
      minLiquidity: 5,
      observedAt: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(m.state).toBe('TRADEABLE');
    expect(isTradeableState(m.state)).toBe(true);
  });

  it('refuses to validate on an estimate', () => {
    const m = atValidating();
    const outcome = m.validate({
      liquidity: estimated(1_000, { observedAt: NOW, source: SOURCE }),
      minLiquidity: 5,
      observedAt: NOW,
    });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.rejection.code).toBe('INSUFFICIENT_EVIDENCE');
      expect(outcome.rejection.message).toContain('ESTIMATED');
    }
    expect(m.state).toBe('LIQUIDITY_VALIDATING');
  });

  it('refuses to validate on an unavailable reading', () => {
    const m = atValidating();
    const outcome = m.validate({
      liquidity: unavailable<number>({ observedAt: NOW, source: SOURCE }),
      minLiquidity: 0,
      observedAt: NOW,
    });

    expect(outcome.applied).toBe(false);
    expect(m.state).toBe('LIQUIDITY_VALIDATING');
  });

  it('still requires a reading when the floor is zero', () => {
    // "No configured minimum" must not mean "an unread pool passes".
    const m = atValidating();
    const outcome = m.validate({
      liquidity: unavailable<number>({ observedAt: NOW, source: SOURCE }),
      minLiquidity: 0,
      observedAt: NOW,
    });

    expect(outcome.applied).toBe(false);
  });

  it('degrades rather than promotes when below the floor', () => {
    const m = atValidating();
    const outcome = m.validate({
      liquidity: observed(1, { slot: slot(104), observedAt: NOW, source: SOURCE }),
      minLiquidity: 5,
      observedAt: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(m.state).toBe('LIQUIDITY_DEGRADED');
    if (outcome.applied) {
      expect(outcome.record.reason).toBe('LIQUIDITY_BELOW_THRESHOLD');
    }
  });

  it('allows recovery from degraded back to tradeable', () => {
    const m = atValidating();
    m.validate({
      liquidity: observed(1, { slot: slot(104), observedAt: NOW, source: SOURCE }),
      minLiquidity: 5,
      observedAt: NOW,
    });
    expect(m.state).toBe('LIQUIDITY_DEGRADED');

    const outcome = m.validate({
      liquidity: observed(20, { slot: slot(105), observedAt: NOW, source: SOURCE }),
      minLiquidity: 5,
      observedAt: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(m.state).toBe('TRADEABLE');
  });
});
