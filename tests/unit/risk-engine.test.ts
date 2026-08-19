import { RiskEngine } from '@mayhem/risk-engine/engine';
import { RiskConfig, RiskCheck } from '@mayhem/risk-engine/types';

function makeConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    minLiquiditySol: 5,
    maxTopHolderPercent: 20,
    minHolders: 10,
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    maxDailyLossSol: 1,
    maxExposureSol: 0.5,
    cooldownMs: 5000,
    emergencyStop: false,
    ...overrides,
  };
}

function passing(name: string): RiskCheck {
  return { name, passed: true, value: 0, threshold: 0, message: 'ok' };
}

function failing(name: string): RiskCheck {
  return { name, passed: false, value: 0, threshold: 0, message: 'fail' };
}

describe('RiskEngine', () => {
  let engine: RiskEngine;

  beforeEach(() => {
    engine = new RiskEngine(makeConfig());
  });

  // --- checkDailyLoss ---
  it('checkDailyLoss passes when under limit', () => {
    const check = engine.checkDailyLoss(0.5);
    expect(check.passed).toBe(true);
  });

  it('checkDailyLoss fails when over limit', () => {
    const check = engine.checkDailyLoss(1.5);
    expect(check.passed).toBe(false);
  });

  // --- checkPositionLimit ---
  it('checkPositionLimit passes when under max', () => {
    const check = engine.checkPositionLimit(2, 5);
    expect(check.passed).toBe(true);
  });

  it('checkPositionLimit fails when at max', () => {
    const check = engine.checkPositionLimit(5, 5);
    expect(check.passed).toBe(false);
  });

  // --- checkExposure ---
  it('checkExposure passes when within limit', () => {
    const check = engine.checkExposure(0.3);
    expect(check.passed).toBe(true);
  });

  it('checkExposure fails when over limit', () => {
    const check = engine.checkExposure(1.0);
    expect(check.passed).toBe(false);
  });

  // --- checkLiquidity ---
  it('checkLiquidity passes when above threshold', () => {
    const check = engine.checkLiquidity(10);
    expect(check.passed).toBe(true);
  });

  it('checkLiquidity fails when below threshold', () => {
    const check = engine.checkLiquidity(2);
    expect(check.passed).toBe(false);
  });

  // --- checkWalletBalance ---
  it('checkWalletBalance passes when sufficient', () => {
    const check = engine.checkWalletBalance(1.0, 0.5);
    expect(check.passed).toBe(true);
  });

  it('checkWalletBalance fails when insufficient', () => {
    const check = engine.checkWalletBalance(0.1, 0.5);
    expect(check.passed).toBe(false);
  });

  // --- checkCooldown ---
  it('checkCooldown passes after cooldown period', () => {
    const oldTime = new Date(Date.now() - 10_000);
    const check = engine.checkCooldown(oldTime);
    expect(check.passed).toBe(true);
  });

  it('checkCooldown fails during cooldown period', () => {
    const recentTime = new Date(Date.now() - 1_000);
    const check = engine.checkCooldown(recentTime);
    expect(check.passed).toBe(false);
  });

  // --- checkEmergencyStop ---
  it('checkEmergencyStop passes when false', () => {
    const check = engine.checkEmergencyStop();
    expect(check.passed).toBe(true);
  });

  it('checkEmergencyStop fails when true', () => {
    engine.setEmergencyStop(true);
    const check = engine.checkEmergencyStop();
    expect(check.passed).toBe(false);
  });

  // --- setEmergencyStop ---
  it('setEmergencyStop toggles correctly', () => {
    expect(engine.checkEmergencyStop().passed).toBe(true);
    engine.setEmergencyStop(true);
    expect(engine.checkEmergencyStop().passed).toBe(false);
    engine.setEmergencyStop(false);
    expect(engine.checkEmergencyStop().passed).toBe(true);
  });

  // --- canTrade ---
  it('canTrade returns true only when ALL checks pass', () => {
    const checks = [passing('a'), passing('b'), passing('c')];
    expect(engine.canTrade(checks)).toBe(true);
  });

  it('canTrade returns false if ANY check fails', () => {
    const checks = [passing('a'), failing('b'), passing('c')];
    expect(engine.canTrade(checks)).toBe(false);
  });

  it('canTrade returns true for empty checks array', () => {
    expect(engine.canTrade([])).toBe(true);
  });

  // --- checkSlippage ---
  it('checkSlippage passes when within max', () => {
    const check = engine.checkSlippage(1.0, 2.0);
    expect(check.passed).toBe(true);
  });

  it('checkSlippage fails when exceeding max', () => {
    const check = engine.checkSlippage(3.0, 2.0);
    expect(check.passed).toBe(false);
  });
});