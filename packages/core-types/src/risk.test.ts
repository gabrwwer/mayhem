
import { describe, expect, it } from 'vitest';
import { RiskVerdictSchema, denyVerdict } from './risk.js';
import { CorrelationIdSchema, TimestampSchema } from './primitives.js';

/**
 * Raw form, for the schema tests below: `parse()` takes `unknown`, so these
 * are fed in unbranded on purpose — that is exactly what a caller does.
 */
const rawBase = {
  verdictId: '33333333-3333-4333-8333-333333333333',
  correlationId: '22222222-2222-4222-8222-222222222222',
  intentId: '11111111-1111-4111-8111-111111111111',
  evaluatedAt: 1_700_000_000_000,
};

/**
 * Branded form, for `denyVerdict`, whose signature demands branded ids.
 *
 * Built by parsing through the real schemas rather than casting. A cast
 * would silence the compiler while letting the test pass values the brand
 * is meant to reject — which would make this suite agree with code that
 * production types would refuse.
 */
const base = {
  verdictId: rawBase.verdictId,
  correlationId: CorrelationIdSchema.parse(rawBase.correlationId),
  intentId: rawBase.intentId,
  evaluatedAt: TimestampSchema.parse(rawBase.evaluatedAt),
};

describe('RiskVerdictSchema', () => {
  it('rejects an approval that also reports breaches', () => {
    const result = RiskVerdictSchema.safeParse({
      ...rawBase,
      approved: true,
      approvedAmountIn: '1000',
      riskScore: 10,
      breaches: [
        { rule: 'daily_loss_limit', observed: '5', limit: '4', message: 'daily loss exceeded' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rejection that reports no breach', () => {
    const result = RiskVerdictSchema.safeParse({
      ...rawBase,
      approved: false,
      riskScore: 90,
      breaches: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an approval that omits the approved size', () => {
    const result = RiskVerdictSchema.safeParse({
      ...rawBase,
      approved: true,
      riskScore: 10,
      breaches: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an approval that caps the size below the request', () => {
    const verdict = RiskVerdictSchema.parse({
      ...rawBase,
      approved: true,
      approvedAmountIn: '500',
      enforcedMaxSlippageBps: 50,
      riskScore: 25,
      breaches: [],
    });
    expect(verdict.approvedAmountIn).toBe(500n);
  });
});

describe('denyVerdict', () => {
  it('produces a maximally risky, unapproved verdict', () => {
    const verdict = denyVerdict(base, [
      {
        rule: 'kill_switch_engaged',
        observed: 'engaged',
        limit: 'disengaged',
        message: 'kill switch engaged',
      },
    ]);

    expect(verdict.approved).toBe(false);
    expect(verdict.riskScore).toBe(100);
    expect(verdict.approvedAmountIn).toBeUndefined();
  });
});