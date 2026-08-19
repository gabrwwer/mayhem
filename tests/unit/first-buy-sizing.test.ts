/**
 * Regression tests for fixed first-buy sizing (audit finding F3).
 *
 * Context: position size was `min(maxPositionSol, depth * participationBps)`.
 * A pump.fun bonding curve at launch has `realSolReserves == 0` — nobody has
 * bought yet — so the participation cap was 0 and `evaluateToken` rejected the
 * candidate as `liquidity_unknown`. Launch-time entry was therefore
 * structurally impossible, which is the opposite of the strategy's intent.
 *
 * The fix adds a narrow exception: when the caller has SUCCESSFULLY READ depth
 * and that reading was zero, size on the absolute risk budget instead. These
 * tests exist to keep the exception narrow. The fail-closed behaviour for
 * genuinely unknown depth is a capital-preservation control and must survive.
 */

import { MayhemEngine, PositionManager } from '@mayhem/trading-engine';
import type { TradingConfig } from '@mayhem/trading-engine';

const config: TradingConfig = {
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
  newLaunchMode: true,
  maxQuoteAgeMs: 5000,
  maxSellPriceImpactPercent: 15,
  exitRetryMaxAttempts: 3,
  exitRetryDelayMs: 100,
  minRiskScore: 30,
  maxLiquidityParticipationBps: 100,
  maxPriceAgeMs: 15_000,
  takeProfitRetryDelayMs: 10_000,
};

const mockExecution = {
  quoteBuy: jest.fn(),
  quoteSell: jest.fn(),
  buildBuyTransaction: jest.fn(),
  buildSellTransaction: jest.fn(),
  signAndSendTransaction: jest.fn(),
  simulateTransaction: jest.fn(),
};

const mockRisk = {
  canTrade: jest.fn().mockReturnValue(true),
  assessToken: jest.fn().mockReturnValue({ level: 'SAFE', score: 85 }),
  checkWalletBalance: jest.fn().mockReturnValue({ passed: true }),
  checkPositionLimit: jest.fn().mockReturnValue({ passed: true }),
  checkExposure: jest.fn().mockReturnValue({ passed: true }),
  checkEmergencyStop: jest.fn().mockReturnValue({ passed: true }),
  checkTokenRisk: jest.fn().mockReturnValue({ passed: true }),
  setEmergencyStop: jest.fn(),
};

describe('first-buy sizing on a zero-depth bonding curve', () => {
  let engine: MayhemEngine;
  let pm: PositionManager;

  beforeEach(() => {
    pm = new PositionManager(config);
    engine = new MayhemEngine(config, pm, mockExecution as any, mockRisk as any);
    jest.clearAllMocks();
  });

  it('sizes a measured-zero curve at the fixed budget', () => {
    const signal = engine.evaluateToken('MINT_LAUNCH', 0.0000001, 0, 85, {
      depthMeasured: true,
    });

    expect(signal).not.toBeNull();
    expect(signal!.amount).toBe(config.maxPositionSol);
    expect(signal!.reason).toContain('fixed_first_buy');
  });

  it('STILL REJECTS zero depth when it was not measured', () => {
    // The load-bearing case: "we could not read the curve" must never be
    // treated as "the curve is empty". Regression here reopens the path where
    // an unreadable venue is traded at full size.
    expect(engine.evaluateToken('MINT_UNKNOWN', 0.0000001, 0, 85)).toBeNull();
    expect(
      engine.evaluateToken('MINT_UNKNOWN', 0.0000001, 0, 85, { depthMeasured: false }),
    ).toBeNull();
  });

  it('rejects negative or non-finite depth regardless of the flag', () => {
    expect(
      engine.evaluateToken('MINT_BAD', 0.0000001, -1, 85, { depthMeasured: true }),
    ).toBeNull();
    expect(
      engine.evaluateToken('MINT_BAD', 0.0000001, NaN, 85, { depthMeasured: true }),
    ).toBeNull();
    expect(
      engine.evaluateToken('MINT_BAD', 0.0000001, Infinity, 85, { depthMeasured: true }),
    ).toBeNull();
  });

  it('keeps participation-based sizing wherever depth is positive', () => {
    // 1% of 2 SOL = 0.02, below the 0.05 budget: the cap must still bind.
    const shallow = engine.evaluateToken('MINT_SHALLOW', 0.001, 2, 85, {
      depthMeasured: true,
    });
    expect(shallow!.amount).toBeCloseTo(0.02, 10);
    expect(shallow!.reason).toContain('depth_participation');

    // 1% of 100 SOL = 1.0, above the budget: maxPositionSol must bind.
    const deep = engine.evaluateToken('MINT_DEEP', 0.001, 100, 85);
    expect(deep!.amount).toBe(config.maxPositionSol);
    expect(deep!.reason).toContain('depth_participation');
  });

  it('never exceeds maxPositionSol on any path', () => {
    for (const [liquidity, depthMeasured] of [
      [0, true],
      [0.0001, true],
      [2, true],
      [1_000_000, false],
    ] as const) {
      const signal = engine.evaluateToken('MINT_CAP', 0.001, liquidity, 85, {
        depthMeasured,
      });
      if (signal) {
        expect(signal.amount).toBeLessThanOrEqual(config.maxPositionSol);
        expect(signal.amount).toBeGreaterThan(0);
      }
    }
  });

  it('remains subject to the risk-score floor and entry switch', () => {
    // The sizing change must not become a bypass for any other control.
    expect(
      engine.evaluateToken('MINT_LOWRISK', 0.001, 0, 10, { depthMeasured: true }),
    ).toBeNull();

    const disabled = new MayhemEngine(
      { ...config, entryEnabled: false },
      new PositionManager(config),
      mockExecution as any,
      mockRisk as any,
    );
    expect(
      disabled.evaluateToken('MINT_OFF', 0.001, 0, 85, { depthMeasured: true }),
    ).toBeNull();
  });

  it('rejects an invalid price even on the fixed-budget path', () => {
    expect(engine.evaluateToken('MINT_P', 0, 0, 85, { depthMeasured: true })).toBeNull();
    expect(engine.evaluateToken('MINT_P', -1, 0, 85, { depthMeasured: true })).toBeNull();
  });
});
