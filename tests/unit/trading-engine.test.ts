// See finding F25: packages/trading-engine/src held a stale, divergent copy.
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
  newLaunchMode: false,
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
  quoteBuy: jest.fn().mockResolvedValue({
    inputMint: 'SOL', outputMint: 'TOKEN', inputAmount: 0.05,
    outputAmount: 1000, pricePerToken: 0.00005, priceImpactPct: 0.1,
    slippageBps: 50, route: 'simulated',
  }),
  quoteSell: jest.fn().mockResolvedValue({
    inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
    outputAmount: 0.06, pricePerToken: 0.00006, priceImpactPct: 0.1,
    slippageBps: 50, route: 'simulated',
  }),
  // Pass the quote through so signAndSendTransaction can report fill
  // amounts that actually correspond to the leg being executed. A fixed
  // buy-shaped fill would make every SELL look like a partial fill of
  // 0.05 tokens out of 1000, leaving positions open.
  buildBuyTransaction: jest.fn((quote: any) => Promise.resolve(quote)),
  buildSellTransaction: jest.fn((quote: any) => Promise.resolve(quote)),
  signAndSendTransaction: jest.fn((quote: any) =>
    Promise.resolve({
      signature: 'fake_sig',
      status: 'confirmed',
      slot: 1,
      error: null,
      fees: 0.000005,
      filledInputAmount: quote?.inputAmount,
      filledOutputAmount: quote?.outputAmount,
    }),
  ),
  simulateTransaction: jest.fn().mockResolvedValue({ success: true }),
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

describe('MayhemEngine', () => {
  let engine: MayhemEngine;
  let pm: PositionManager;

  beforeEach(() => {
    pm = new PositionManager(config);
    engine = new MayhemEngine(config, pm, mockExecution as any, mockRisk as any);
    jest.clearAllMocks();
  });

  test('evaluateToken returns null when entry not enabled', () => {
    const disabledEngine = new MayhemEngine(
      { ...config, entryEnabled: false }, pm, mockExecution as any, mockRisk as any,
    );
    const signal = disabledEngine.evaluateToken('MINT1', 0.001, 10, 85);
    expect(signal).toBeNull();
  });

  test('evaluateToken returns buy signal for safe token', () => {
    const signal = engine.evaluateToken('MINT1', 0.001, 10, 85);
    expect(signal).not.toBeNull();
    expect(signal?.action).toBe('buy');
  });

  test('evaluateToken returns null for blocked token (score < 30)', () => {
    const signal = engine.evaluateToken('MINT1', 0.001, 10, 15);
    expect(signal).toBeNull();
  });

  test('executeEntry creates position', async () => {
    const signal = { tokenMint: 'MINT1', action: 'buy' as const, reason: 'test', price: 0.001, amount: 0.05, timestamp: new Date() };
    const entryHandler = jest.fn();
    engine.on('entry', entryHandler);
    const pos = await engine.executeEntry(signal);
    expect(pos).not.toBeNull();
    expect(pos?.status).toBe('open');
  });

  test('monitorPositions updates open positions', async () => {
    pm.openPosition('MINT1', 0.001, 1000);
    const updates = await engine.monitorPositions();
    expect(updates.length).toBe(1);
  });

  test('emergencyExitAll closes all positions', async () => {
    pm.openPosition('MINT1', 0.001, 1000);
    pm.openPosition('MINT2', 0.002, 500);
    const closed = await engine.emergencyExitAll('test_emergency');
    expect(closed.length).toBe(2);
    expect(closed.every(p => p.status === 'closed')).toBe(true);
  });

  test('emits entry event', async () => {
    const handler = jest.fn();
    engine.on('entry', handler);
    const signal = { tokenMint: 'MINT1', action: 'buy' as const, reason: 'test', price: 0.001, amount: 0.05, timestamp: new Date() };
    await engine.executeEntry(signal);
    expect(handler).toHaveBeenCalled();
  });

  test('emits emergency event', async () => {
    const handler = jest.fn();
    engine.on('emergency', handler);
    pm.openPosition('MINT1', 0.001, 1000);
    await engine.emergencyExitAll('test');
    expect(handler).toHaveBeenCalled();
  });
});