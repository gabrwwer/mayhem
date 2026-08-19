
import {
  OrderIntentSchema,
  RiskLimitsSchema,
  TimestampSchema,
  type OrderIntent,
  type RiskLimits,
  type RiskRule,
  type Timestamp,
} from '@mayhem/core-types';
import { describe, expect, it } from 'vitest';

import { RiskContextSchema, type RiskContext } from './context.js';
import { RiskEngine } from './engine.js';

const NOW = 1_700_000_000_000;
const SOL = '11111111111111111111111111111111';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const LIMITS: RiskLimits = RiskLimitsSchema.parse({
  maxPositionLamports: '100000000',
  maxNotionalPerOrderLamports: '50000000',
  maxStrategyExposureLamports: '200000000',
  maxGlobalExposureLamports: '400000000',
  maxConcentrationBps: 5_000,
  maxSlippageBps: 300,
  maxLiquidityParticipationBps: 100,
  manipulationScoreThreshold: 70,
  dailyLossLimitLamports: '10000000',
  maxDrawdownBps: 2_000,
  maxConsecutiveLosses: 3,
  maxMarketDataAgeMs: 2_000,
  maxExecutionLatencyMs: 1_500,
});

function intent(overrides: Partial<Record<string, unknown>> = {}): OrderIntent {
  return OrderIntentSchema.parse({
    intentId: '11111111-1111-4111-8111-111111111111',
    correlationId: '22222222-2222-4222-8222-222222222222',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    proposedBy: 'launch-tracker',
    strategyId: 'sniper',
    environment: 'paper',
    side: 'buy',
    inputMint: SOL,
    outputMint: MINT,
    amountIn: '10000000',
    maxSlippageBps: 200,
    priorityFeeMicroLamports: 10_000,
    confidence: 0.8,
    rationale: 'test',
    ...overrides,
  });
}

function context(overrides: Record<string, unknown> = {}): RiskContext {
  const { market, portfolio, ...rest } = overrides as {
    market?: Record<string, unknown> | null;
    portfolio?: Record<string, unknown>;
  } & Record<string, unknown>;

  return RiskContextSchema.parse({
    now: NOW,
    killSwitchEngaged: false,
    quarantinedAgents: [],
    quarantinedStrategies: [],
    notionalLamports: '10000000',
    ...(market === null
      ? {}
      : {
          market: {
            mint: MINT,
            asOf: NOW - 500,
            poolLiquidityLamports: '100000000000',
            estimatedSlippageBps: 50,
            manipulationScore: 5,
            sellable: true,
            ...market,
          },
        }),
    portfolio: {
      asOf: NOW - 100,
      positionLamports: '0',
      strategyExposureLamports: '0',
      globalExposureLamports: '0',
      dailyRealizedLossLamports: '0',
      peakEquityLamports: '1000000000',
      currentEquityLamports: '1000000000',
      consecutiveLosses: 0,
      observedExecutionLatencyMs: 200,
      ...portfolio,
    },
    ...rest,
  });
}

function engine(limits: RiskLimits = LIMITS): RiskEngine {
  let n = 0;
  const now: () => Timestamp = () => TimestampSchema.parse(NOW);

  return new RiskEngine({
    limits,
    now,
    newVerdictId: () => `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`,
  });
}

const rules = (ctx: RiskContext, order: OrderIntent = intent()): RiskRule[] =>
  engine()
    .evaluate(order, ctx)
    .breaches.map((b) => b.rule);

describe('RiskEngine', () => {
  it('approves an order that is within every limit', () => {
    const verdict = engine().evaluate(intent(), context());

    expect(verdict.approved).toBe(true);
    expect(verdict.breaches).toEqual([]);
    expect(verdict.approvedAmountIn).toBe(10_000_000n);
  });

  it('threads the intent identifiers into the verdict', () => {
    const order = intent();
    const verdict = engine().evaluate(order, context());

    expect(verdict.intentId).toBe(order.intentId);
    expect(verdict.correlationId).toBe(order.correlationId);
  });

  describe('fails closed', () => {
    it('denies when no market snapshot is supplied', () => {
      expect(rules(context({ market: null }))).toEqual(['market_data_unavailable']);
    });

    it('denies on stale market data rather than trading on it', () => {
      expect(rules(context({ market: { asOf: NOW - 5_000 } }))).toContain('stale_market_data');
    });

    it('denies everything while the kill switch is engaged', () => {
      expect(rules(context({ killSwitchEngaged: true }))).toContain('kill_switch_engaged');
    });

    it('denies an intent that expired before evaluation', () => {
      expect(rules(context({ now: NOW }), intent({ expiresAt: NOW }))).toContain('intent_expired');
    });

    it('denies a quarantined agent and a quarantined strategy', () => {
      expect(rules(context({ quarantinedAgents: ['launch-tracker'] }))).toContain(
        'agent_quarantined',
      );
      expect(rules(context({ quarantinedStrategies: ['sniper'] }))).toContain('agent_quarantined');
    });

    it('denies a mint that is not demonstrably sellable', () => {
      expect(rules(context({ market: { sellable: false } }))).toContain('token_not_sellable');
    });

    it('never returns approvedAmountIn on a denial', () => {
      const verdict = engine().evaluate(intent(), context({ killSwitchEngaged: true }));

      expect(verdict.approved).toBe(false);
      expect(verdict.approvedAmountIn).toBeUndefined();
      expect(verdict.riskScore).toBe(100);
    });

    it('reports every breach, so one fix does not reveal the next', () => {
      expect(
        rules(
          context({
            killSwitchEngaged: true,
            market: { sellable: false, manipulationScore: 90 },
            portfolio: { consecutiveLosses: 5 },
          }),
        ),
      ).toEqual([
        'kill_switch_engaged',
        'circuit_breaker_consecutive_losses',
        'token_not_sellable',
        'manipulation_suspected',
      ]);
    });
  });

  describe('circuit breakers', () => {
    it('halts for the day at the loss limit', () => {
      expect(rules(context({ portfolio: { dailyRealizedLossLamports: '10000000' } }))).toContain(
        'daily_loss_limit',
      );
    });

    it('trips on drawdown from peak equity', () => {
      expect(
        rules(
          context({
            portfolio: { peakEquityLamports: '1000000000', currentEquityLamports: '700000000' },
          }),
        ),
      ).toContain('max_drawdown');
    });

    it('tolerates drawdown exactly at the limit', () => {
      expect(
        rules(
          context({
            portfolio: { peakEquityLamports: '1000000000', currentEquityLamports: '800000000' },
          }),
        ),
      ).toEqual([]);
    });

    it('trips on execution latency', () => {
      expect(rules(context({ portfolio: { observedExecutionLatencyMs: 5_000 } }))).toContain(
        'circuit_breaker_latency',
      );
    });
  });

  describe('slippage', () => {
    it('enforces the tighter of the intent bound and the configured bound', () => {
      const verdict = engine().evaluate(intent({ maxSlippageBps: 50 }), context());

      expect(verdict.enforcedMaxSlippageBps).toBe(50);
    });

    it('does not let an intent widen the configured bound', () => {
      const verdict = engine().evaluate(intent({ maxSlippageBps: 9_000 }), context());

      expect(verdict.enforcedMaxSlippageBps).toBe(300);
    });

    it('denies when expected slippage exceeds the enforced bound', () => {
      expect(
        rules(context({ market: { estimatedSlippageBps: 250 } }), intent({ maxSlippageBps: 100 })),
      ).toContain('max_slippage');
    });
  });

  describe('sizing', () => {
    it('shrinks an order to the per-order notional limit', () => {
      const verdict = engine().evaluate(
        intent({ amountIn: '100000000' }),
        context({ notionalLamports: '100000000' }),
      );

      // Half the notional is permitted, so half the input amount is approved.
      expect(verdict.approved).toBe(true);
      expect(verdict.approvedAmountIn).toBe(50_000_000n);
    });

    it('shrinks to the tightest binding limit, not merely the first', () => {
      const verdict = engine().evaluate(
        intent({ amountIn: '100000000' }),
        context({
          notionalLamports: '100000000',
          portfolio: { positionLamports: '90000000' },
        }),
      );

      // Position headroom (10_000_000) binds before the per-order cap.
      expect(verdict.approvedAmountIn).toBe(10_000_000n);
    });

    it('never grows an order', () => {
      const verdict = engine().evaluate(
        intent({ amountIn: '1000' }),
        context({ notionalLamports: '1000' }),
      );

      expect(verdict.approvedAmountIn).toBe(1_000n);
    });

    it('denies rather than filling zero when there is no headroom', () => {
      expect(rules(context({ portfolio: { positionLamports: '100000000' } }))).toEqual([
        'max_position_size',
      ]);
    });

    it('denies when the strategy is at its exposure limit', () => {
      expect(rules(context({ portfolio: { strategyExposureLamports: '200000000' } }))).toEqual([
        'max_strategy_exposure',
      ]);
    });

    it('denies when the portfolio is at its global exposure limit', () => {
      expect(
        rules(
          context({
            portfolio: {
              globalExposureLamports: '400000000',
              strategyExposureLamports: '100000000',
            },
          }),
        ),
      ).toContain('max_global_exposure');
    });

    it('caps participation in a thin pool', () => {
      const verdict = engine().evaluate(
        intent({ amountIn: '10000000' }),
        context({ notionalLamports: '10000000', market: { poolLiquidityLamports: '100000000' } }),
      );

      // 100 bps of a 100_000_000 lamport pool.
      expect(verdict.approvedAmountIn).toBe(1_000_000n);
    });

    it('denies when the pool is too thin for any size', () => {
      expect(rules(context({ market: { poolLiquidityLamports: '0' } }))).toEqual([
        'liquidity_insufficient',
      ]);
    });

    it('holds concentration under the cap as the position grows', () => {
      const verdict = engine().evaluate(
        intent({ amountIn: '100000000' }),
        context({
          notionalLamports: '100000000',
          portfolio: {
            positionLamports: '40000000',
            peakEquityLamports: '100000000',
            currentEquityLamports: '100000000',
          },
        }),
      );

      // 50% of 100M equity, less the 40M already held.
      expect(verdict.approvedAmountIn).toBe(10_000_000n);
    });

    it('denies when the position is already over-concentrated', () => {
      expect(
        rules(
          context({
            portfolio: {
              positionLamports: '60000000',
              peakEquityLamports: '100000000',
              currentEquityLamports: '100000000',
            },
          }),
        ),
      ).toContain('max_concentration');
    });
  });

  describe('manipulation', () => {
    it('denies at or above the configured score, and only detects', () => {
      expect(rules(context({ market: { manipulationScore: 70 } }))).toEqual([
        'manipulation_suspected',
      ]);
      expect(rules(context({ market: { manipulationScore: 69 } }))).toEqual([]);
    });

    it('surfaces a benign-but-elevated score through the residual risk score', () => {
      const verdict = engine().evaluate(intent(), context({ market: { manipulationScore: 60 } }));

      expect(verdict.approved).toBe(true);
      expect(verdict.riskScore).toBe(60);
    });
  });
});