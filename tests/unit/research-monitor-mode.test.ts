import { describe, it, expect, vi } from 'vitest';
import { NewLaunchHandler } from '../../apps/bot/src/new-launch-handler';

describe('Research monitor mode', () => {
  it('still evaluates risk and momentum when trading is disabled so decision records are emitted', async () => {
    const recorder = {
      recordDiscovery: vi.fn(),
      recordObservation: vi.fn(),
      recordDecision: vi.fn(),
      recordExecution: vi.fn(),
      recordOutcome: vi.fn(),
    };

    const mayhemEngine = {
      emergencyExitToken: vi.fn().mockResolvedValue([]),
      getResearchRecorder: () => recorder,
      evaluateToken: vi.fn().mockReturnValue(null),
      executeEntry: vi.fn(),
    };

    const riskGate = {
      assess: vi.fn().mockResolvedValue({
        canTrade: true,
        level: 'SAFE',
        score: 95,
        reason: 'ok',
      }),
    };

    const breaker = {
      shouldBlock: () => ({ block: false, reason: null }),
    };

    const handler = new NewLaunchHandler(
      mayhemEngine as any,
      {
        getPrice: vi.fn().mockResolvedValue(2.1),
        getExecutableQuote: vi.fn().mockResolvedValue({
          price: 2.1,
          timestamp: Date.now(),
          priceImpactBps: 10,
        }),
      },
      {
        TRADING_ENABLED: false,
        MIN_LIQUIDITY_SOL: 0,
        MIN_RISK_SCORE: 80,
        MAX_CONCURRENT_EVALUATIONS: 3,
        MOMENTUM_CONFIRM_ENABLED: false,
        MOMENTUM_CONFIRM_DURATION_MS: 1000,
        MOMENTUM_CONFIRM_INTERVAL_MS: 500,
        MIN_MOMENTUM_SAMPLES: 1,
        MIN_MOMENTUM_CHANGE_PCT: 1,
        MIN_BUY_PRESSURE: 0.1,
        MAX_MOMENTUM_VOLATILITY: 1,
        MAX_MOMENTUM_DRAWDOWN_PCT: 100,
        MAX_FLAT_RATIO: 1,
        RESEARCH_MODE_ENABLED: true,
        RESEARCH_RECORD_DISCOVERY: true,
        RESEARCH_RECORD_ENRICHMENT: true,
        RESEARCH_RECORD_SAMPLES: true,
        RESEARCH_RECORD_REJECTIONS: true,
        RESEARCH_RECORD_ENTRIES: true,
        RESEARCH_RECORD_INCOMPLETE: true,
        RESEARCH_OBSERVATION_WINDOW_MS: 5000,
        RESEARCH_SAMPLE_INTERVAL_MS: 1000,
        RESEARCH_MAX_SAMPLES: 10,
        RESEARCH_MAX_CONCURRENT_OBSERVATIONS: 3,
        RESEARCH_RPC_COMMITMENT: 'confirmed',
        RESEARCH_RECORD_SLOT: true,
        RESEARCH_RECORD_TIMESTAMPS: true,
        RESEARCH_COLLECT_HOLDERS: false,
        RESEARCH_MAX_TOP_HOLDERS: 5,
        RESEARCH_COLLECT_HOLDER_DISTRIBUTION: false,
        RESEARCH_COLLECT_CURVE_STATE: false,
        RESEARCH_COLLECT_POOL_STATE: false,
        RESEARCH_COLLECT_TRANSACTION_FLOW: false,
        RESEARCH_COLLECT_BUY_SELL_VOLUME: false,
        RESEARCH_COLLECT_UNIQUE_TRADERS: false,
        RESEARCH_COLLECT_LARGEST_TRADES: false,
        RESEARCH_COLLECT_TRANSACTION_VELOCITY: false,
        RESEARCH_COLLECT_PRICE_IMPACT: false,
        RESEARCH_COLLECT_QUOTES: false,
        RESEARCH_MAX_QUOTE_AGE_MS: 5000,
        RESEARCH_RECORD_RPC_FAILURES: true,
        RESEARCH_RECORD_DATA_STATUS: true,
        RESEARCH_METADATA_CACHE_TTL_MS: 60000,
        RESEARCH_METADATA_CACHE_MAX: 100,
      } as any,
      riskGate as any,
      breaker as any,
    );

    // Bypass the live sampling loop while still exercising the monitor-only gate.
    (handler as any).confirmMomentum = async () => ({
      confirmed: true,
      finalPrice: 2.25,
      growthPerMin: 10,
      maxDrawdownPct: 1,
      buyPressure: 0.8,
      flowBuyPressure: 0.8,
      finalDrawdownPct: 1,
      flatRatio: 0.1,
      netFlowPct: 5,
      volatility: 0.2,
      samples: 5,
      flatIntervals: 1,
      failedReads: 0,
      reason: 'ok',
    });

    await handler.handleNewToken({
      tokenMint: 'DemoMint11111111111111111111111111111111111',
      source: 'solana-onchain:token-created',
      isPumpFun: true,
      initialLiquidity: 100,
      createdAt: new Date(),
      txSignature: 'sig-demo',
    } as any);

    expect(recorder.recordObservation).toHaveBeenCalled();
    expect(recorder.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'REJECT',
        reason: expect.stringContaining('monitor-only'),
      }),
    );
    expect(mayhemEngine.evaluateToken).not.toHaveBeenCalled();
  });
});
