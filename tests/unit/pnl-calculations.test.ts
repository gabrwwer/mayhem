// Import the published package, not the relative path into packages/.
// `packages/trading-engine/src` held a divergent stale copy of these files;
// tests that reached into it were exercising different code from the one
// the bot actually loads.
import { PositionManager } from '@mayhem/trading-engine';
import type { TradingConfig } from '@mayhem/trading-engine';
import { parseAmount } from '../../packages/trading-engine/src/calculations';

function expectAmount(actual: string, expected: string): void {
  expect(parseAmount(actual).equals(parseAmount(expected))).toBe(true);
}

function makeConfig(overrides: Partial<TradingConfig> = {}): TradingConfig {
  return {
    entryEnabled: true,
    maxPositionSol: 0.05,
    takeProfitPercent: 20,
    profitMonitorActivationPercent: 8,
    profitLockActivationPercent: 12,
    profitLockPercent: 3,
    trailingActivationPercent: 15,
    aggressiveTrailingActivationPercent: 20,
    stopLossPercent: 10,
    hardStopLossPercent: 10,
    trailingStopPercent: 8,
    maxHoldSeconds: 300,
    maxOpenPositions: 3,
    entryDelayMs: 0,
    newLaunchMode: false,
    maxQuoteAgeMs: 5000,
    maxSellPriceImpactPercent: 15,
    exitRetryMaxAttempts: 3,
    exitRetryDelayMs: 100,
    minRiskScore: 80,
    maxLiquidityParticipationBps: 100,
    maxPriceAgeMs: 15_000,
    takeProfitRetryDelayMs: 10_000,
    ...overrides,
  };
}

describe('PnL Calculations', () => {
  let pm: PositionManager;

  beforeEach(() => {
    pm = new PositionManager(makeConfig());
  });

  test('profit scenario: +50% price increase', () => {
    const pos = pm.openPosition('MINT1', '1', '100');
    const update = pm.updatePosition(pos.id, '1.5');
    expectAmount(update.unrealizedPnl, '50');
  });

  test('loss scenario: -25% price decrease', () => {
    const pos = pm.openPosition('MINT1', '1', '100');
    const update = pm.updatePosition(pos.id, '0.75');
    expectAmount(update.unrealizedPnl, '-25');
  });

  test('break-even', () => {
    const pos = pm.openPosition('MINT1', '1', '100');
    const update = pm.updatePosition(pos.id, '1');
    expectAmount(update.unrealizedPnl, '0');
  });

  test('take profit triggers at exactly threshold', () => {
    const pm20 = new PositionManager(makeConfig({ takeProfitPercent: 20 }));
    const pos = pm20.openPosition('MINT1', '1', '100');
    const update = pm20.updatePosition(pos.id, '1.2');
    const tpCondition = update.exitConditions.find(c => c.type === 'take_profit');
    expect(tpCondition?.triggered).toBe(true);
  });

  test('stop loss triggers at exactly threshold', () => {
    const pm10 = new PositionManager(makeConfig({ stopLossPercent: 10 }));
    const pos = pm10.openPosition('MINT1', '1', '100');
    const update = pm10.updatePosition(pos.id, '0.9');
    const slCondition = update.exitConditions.find(c => c.type === 'stop_loss');
    expect(slCondition?.triggered).toBe(true);
  });

  test('trailing stop: price rises 50%, then drops 8% from high', () => {
    const pm8 = new PositionManager(makeConfig({ trailingStopPercent: 8 }));
    const pos = pm8.openPosition('MINT1', '1', '100');

    pm8.updatePosition(pos.id, '1.5');
    const update = pm8.updatePosition(pos.id, '1.38');
    const tsCondition = update.exitConditions.find(c => c.type === 'trailing_stop');
    expect(tsCondition?.triggered).toBe(true);
  });

  test('trailing stop: price rises but drop is insufficient', () => {
    const pm8 = new PositionManager(makeConfig({ trailingStopPercent: 8 }));
    const pos = pm8.openPosition('MINT1', '1', '100');

    pm8.updatePosition(pos.id, '1.5');
    const update = pm8.updatePosition(pos.id, '1.425');
    const tsCondition = update.exitConditions.find(c => c.type === 'trailing_stop');
    expect(tsCondition?.triggered).toBe(false);
  });

  test('time-based exit at MAX_HOLD_SECONDS', () => {
    const pm1s = new PositionManager(makeConfig({ maxHoldSeconds: 0 }));
    const pos = pm1s.openPosition('MINT1', 1.0, 100);
    const update = pm1s.updatePosition(pos.id, 1.0);
    const timeCondition = update.exitConditions.find(c => c.type === 'time_exit');
    expect(timeCondition?.triggered).toBe(true);
  });

  test('close position records realized PnL', () => {
    const pos = pm.openPosition('MINT1', 1.0, 100);
    // 100 units sold for 130 SOL against a 100 cost basis.
    const closed = pm.closePosition(
      pos.id,
      { soldQuantity: 100, proceeds: 130 },
      'take_profit',
    );
    expect(closed.realizedPnl).toBeCloseTo(30);
    expect(closed.status).toBe('closed');
    expect(closed.exitReason).toBe('take_profit');
  });
});
