// Mock @solana/web3.js to avoid ESM uuid import issue in jest
jest.mock('@solana/web3.js', () => ({
  Transaction: class Transaction {
    partialSign() {}
    serialize() { return Buffer.from([]); }
  },
  Keypair: { generate: () => ({ publicKey: { toBase58: () => 'mock' }, secretKey: new Uint8Array(64) }) },
  PublicKey: class PublicKey { constructor(public key: string) {} toBase58() { return this.key; } },
  Connection: class Connection {},
  ComputeBudgetProgram: { setComputeUnitPrice: () => ({}), setComputeUnitLimit: () => ({}) },
}));

import { SimulatedExecutionEngine } from '@mayhem/execution';
import { MayhemEngine, PositionManager } from '@mayhem/trading-engine';
import { RiskEngine } from '@mayhem/risk-engine';

describe('DRY_RUN Safety', () => {
  it('SimulatedExecutionEngine never signs real transactions', async () => {
    const sim = new SimulatedExecutionEngine({
      slippageBps: 100,
      failureRate: 0,
      initialSolBalance: 10,
    });

    const quote = await sim.quoteBuy('FakeToken111111111111111111111111111111111', 0.1);
    const result = await sim.signAndSendTransaction(quote);

    expect(result.signature).toMatch(/^sim-/);
    expect(result.status).toBe('confirmed');
  });

  it('SimulatedExecutionEngine tracks paper balances', async () => {
    const sim = new SimulatedExecutionEngine({
      slippageBps: 100,
      failureRate: 0,
      initialSolBalance: 1,
    });

    expect(sim.getBalance()).toBe(1);

    const quote = await sim.quoteBuy('TestMint111111111111111111111111111111111', 0.5);
    await sim.signAndSendTransaction(quote);

    expect(sim.getBalance()).toBeLessThan(1);
    expect(sim.getTokenBalance('TestMint111111111111111111111111111111111')).toBeGreaterThan(0);
  });

  it('MayhemEngine does not create entries when entryEnabled=false', () => {
    const config = {
      entryEnabled: false,
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
      // The entry risk threshold is configuration now, not a hardcoded 30
      // inside the engine (finding F15).
      minRiskScore: 30,
      maxLiquidityParticipationBps: 100,
      maxPriceAgeMs: 15_000,
      takeProfitRetryDelayMs: 10_000,
    };

    const pm = new PositionManager(config);
    const riskEngine = new RiskEngine({
      minLiquiditySol: 5,
      maxTopHolderPercent: 20,
      minHolders: 25,
      requireMintAuthorityRevoked: false,
      requireFreezeAuthorityRevoked: false,
      maxDailyLossSol: 1,
      maxExposureSol: 0.5,
      cooldownMs: 5000,
      emergencyStop: false,
    });

    const sim = new SimulatedExecutionEngine({
      slippageBps: 100,
      failureRate: 0,
      initialSolBalance: 1,
    });

    const engine = new MayhemEngine(config, pm, sim, riskEngine);
    const signal = engine.evaluateToken('Test111111111111111111111111111111111111111', 0.001, 100, 80);

    expect(signal).toBeNull();
  });
});

describe('NEW_LAUNCH_MODE', () => {
  it('does not bypass risk checks', () => {
    const config = {
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
      // The entry risk threshold is configuration now, not a hardcoded 30
      // inside the engine (finding F15).
      minRiskScore: 30,
      maxLiquidityParticipationBps: 100,
      maxPriceAgeMs: 15_000,
      takeProfitRetryDelayMs: 10_000,
    };

    const pm = new PositionManager(config);
    const riskEngine = new RiskEngine({
      minLiquiditySol: 5,
      maxTopHolderPercent: 20,
      minHolders: 25,
      requireMintAuthorityRevoked: false,
      requireFreezeAuthorityRevoked: false,
      maxDailyLossSol: 1,
      maxExposureSol: 0.5,
      cooldownMs: 5000,
      emergencyStop: false,
    });

    const sim = new SimulatedExecutionEngine({
      slippageBps: 100,
      failureRate: 0,
      initialSolBalance: 1,
    });

    const engine = new MayhemEngine(config, pm, sim, riskEngine);
    const signal = engine.evaluateToken('Test111111111111111111111111111111111111111', 0.001, 100, 29);
    expect(signal).toBeNull();
  });

  it('does not bypass position limits', () => {
    const config = {
      entryEnabled: true,
      maxPositionSol: 0.05,
      takeProfitPercent: 20,
      stopLossPercent: 10,
      trailingStopPercent: 8,
      maxHoldSeconds: 300,
      maxOpenPositions: 1,
      entryDelayMs: 0,
      newLaunchMode: true,
      minRiskScore: 30,
      maxLiquidityParticipationBps: 100,
      maxPriceAgeMs: 15_000,
      takeProfitRetryDelayMs: 10_000,
    } as any;

    const pm = new PositionManager(config);
    pm.openPosition('Existing111111111111111111111111111111111', 0.001, 100);

    const riskEngine = new RiskEngine({
      minLiquiditySol: 5,
      maxTopHolderPercent: 20,
      minHolders: 25,
      requireMintAuthorityRevoked: false,
      requireFreezeAuthorityRevoked: false,
      maxDailyLossSol: 1,
      maxExposureSol: 0.5,
      cooldownMs: 5000,
      emergencyStop: false,
    });

    const sim = new SimulatedExecutionEngine({
      slippageBps: 100,
      failureRate: 0,
      initialSolBalance: 1,
    });

    const engine = new MayhemEngine(config, pm, sim, riskEngine);
    const signal = engine.evaluateToken('New111111111111111111111111111111111111111', 0.001, 100, 80);
    expect(signal).toBeNull();
  });

  it('does not bypass emergency stop', () => {
    const riskEngine = new RiskEngine({
      minLiquiditySol: 5,
      maxTopHolderPercent: 20,
      minHolders: 25,
      requireMintAuthorityRevoked: false,
      requireFreezeAuthorityRevoked: false,
      maxDailyLossSol: 1,
      maxExposureSol: 0.5,
      cooldownMs: 5000,
      emergencyStop: false,
    });

    riskEngine.setEmergencyStop(true);
    const check = riskEngine.checkEmergencyStop();
    expect(check.passed).toBe(false);
  });
});