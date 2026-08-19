import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  CircuitBreaker,
  freshState,
  serializeBreakerState,
  deserializeBreakerState,
  restoreBreakerState,
  InMemoryBreakerStateStore,
  TokenSafetyScanner,
  type RiskConfig,
} from '@mayhem/risk-engine';

import {
  MayhemEngine,
  PositionManager,
  isFilled,
  isUnresolved,
  serializePosition,
  deserializePosition,
  type TradingConfig,
} from '@mayhem/trading-engine';

/**
 * Regression suite for the findings in docs/audits/MAYHEM_AUDIT.md.
 *
 * Each test names the finding it locks down. These are the tests that would
 * have failed before the fix — if one of them ever goes green for the wrong
 * reason, the corresponding failure mode is back.
 */

const tradingConfig = (overrides: Partial<TradingConfig> = {}): TradingConfig => ({
  entryEnabled: true,
  maxPositionSol: 1,
  takeProfitPercent: 20,
  profitMonitorActivationPercent: 5,
  profitLockActivationPercent: 10,
  profitLockPercent: 50,
  trailingActivationPercent: 15,
  aggressiveTrailingActivationPercent: 20,
  stopLossPercent: 10,
  hardStopLossPercent: 10,
  trailingStopPercent: 8,
  maxHoldSeconds: 3600,
  maxOpenPositions: 5,
  entryDelayMs: 0,
  newLaunchMode: false,
  maxQuoteAgeMs: 5_000,
  maxSellPriceImpactPercent: 50,
  exitRetryMaxAttempts: 2,
  exitRetryDelayMs: 0,
  minRiskScore: 80,
  maxLiquidityParticipationBps: 100,
  maxPriceAgeMs: 15_000,
  takeProfitRetryDelayMs: 10_000,
  ...overrides,
});

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

// ───────────────────────────────────────────────────────────────────────
// F2 — a position may only be opened against a CONFIRMED fill
// ───────────────────────────────────────────────────────────────────────

describe('F2: entry requires a confirmed fill', () => {
  const nonFills = ['pending', 'expired', 'failed', 'weird-unknown-status'];

  for (const status of nonFills) {
    it(`does not open a position when the venue reports "${status}"`, async () => {
      const pm = new PositionManager(tradingConfig());
      const execution = {
        quoteBuy: vi.fn().mockResolvedValue({ pricePerToken: 2, outputAmount: 5 }),
        buildBuyTransaction: vi.fn().mockResolvedValue({}),
        signAndSendTransaction: vi
          .fn()
          .mockResolvedValue({ signature: 'sig', status, error: null, fees: 0 }),
      };

      const engine = new MayhemEngine(tradingConfig(), pm, execution, {}, silentLogger());

      const position = await engine.executeEntry({
        tokenMint: 'MintA',
        action: 'buy',
        reason: 'test',
        price: 2,
        amount: 1,
        timestamp: new Date(),
      });

      expect(position).toBeNull();
      expect(pm.getOpenPositions()).toHaveLength(0);
    });
  }

  it('opens a position on a confirmed fill, sized from the FILL not the quote', async () => {
    const pm = new PositionManager(tradingConfig());
    const execution = {
      // Quote says 5 tokens at 2.0 — the fill says otherwise.
      quoteBuy: vi.fn().mockResolvedValue({ pricePerToken: 2, outputAmount: 5 }),
      buildBuyTransaction: vi.fn().mockResolvedValue({}),
      signAndSendTransaction: vi.fn().mockResolvedValue({
        signature: 'sig',
        status: 'confirmed',
        error: null,
        fees: 0.001,
        filledInputAmount: 1,
        filledOutputAmount: 4,
      }),
    };

    const engine = new MayhemEngine(tradingConfig(), pm, execution, {}, silentLogger());
    const position = await engine.executeEntry({
      tokenMint: 'MintA',
      action: 'buy',
      reason: 'test',
      price: 2,
      amount: 1,
      timestamp: new Date(),
    });

    expect(position).not.toBeNull();
    expect(position!.quantity).toBe(4);
    expect(position!.actualEntryPrice).toBeCloseTo(0.25, 10);
  });

  it('refuses to open when the execution engine exposes no buy path', async () => {
    const pm = new PositionManager(tradingConfig());
    const engine = new MayhemEngine(tradingConfig(), pm, {}, {}, silentLogger());

    const position = await engine.executeEntry({
      tokenMint: 'MintA',
      action: 'buy',
      reason: 'test',
      price: 1,
      amount: 1,
      timestamp: new Date(),
    });

    expect(position).toBeNull();
    expect(pm.getOpenPositions()).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// F4 — circuit-breaker state survives a restart
// ───────────────────────────────────────────────────────────────────────

describe('F4: breaker state is durable across restarts', () => {
  it('a tripped breaker is still tripped after a simulated restart', async () => {
    const store = new InMemoryBreakerStateStore();
    const cfg = {
      maxDailyLossLamports: 1_000_000_000n,
      maxConsecutiveLosses: 3,
      maxDrawdownPct: 25,
      tripCooldownMs: 60_000,
    };

    const before = new CircuitBreaker(cfg, freshState(10_000_000_000n), undefined, (s) => {
      void store.save(serializeBreakerState(s));
    });

    before.kill();
    expect(before.shouldBlock().block).toBe(true);

    // Restart: brand new process, state comes only from the store.
    const restored = await restoreBreakerState({
      store,
      firstRunEquityLamports: 10_000_000_000n,
    });

    const after = new CircuitBreaker(cfg, restored.state);
    expect(restored.origin).toBe('restored');
    expect(after.shouldBlock()).toEqual({ block: true, reason: 'KILL_SWITCH' });
  });

  it('accumulated daily loss survives a restart', async () => {
    const store = new InMemoryBreakerStateStore();
    const cfg = {
      maxDailyLossLamports: 1_000_000_000n,
      maxConsecutiveLosses: 100,
      maxDrawdownPct: 99,
      tripCooldownMs: 0,
    };

    const before = new CircuitBreaker(cfg, freshState(10_000_000_000n), undefined, (s) => {
      void store.save(serializeBreakerState(s));
    });

    before.recordTrade(-1_500_000_000n); // blows the daily cap

    const restored = await restoreBreakerState({
      store,
      firstRunEquityLamports: 10_000_000_000n,
    });
    const after = new CircuitBreaker(cfg, restored.state);

    expect(after.shouldBlock()).toEqual({ block: true, reason: 'DAILY_LOSS_CAP' });
  });

  it('fails CLOSED when the store cannot be read', async () => {
    const brokenStore = {
      load: async () => {
        throw new Error('database unreachable');
      },
      save: async () => {},
    };

    const restored = await restoreBreakerState({
      store: brokenStore,
      firstRunEquityLamports: 1_000n,
      failClosed: true,
    });

    expect(restored.origin).toBe('fail-closed');
    expect(restored.state.killSwitch).toBe(true);
  });

  it('round-trips state without losing bigint precision', () => {
    const state = freshState(12_345_678_901_234_567n);
    state.dailyLossLamports = 98_765_432_109_876_543n;
    const round = deserializeBreakerState(serializeBreakerState(state));
    expect(round.peakEquityLamports).toBe(12_345_678_901_234_567n);
    expect(round.dailyLossLamports).toBe(98_765_432_109_876_543n);
  });

  it('peek() does not mutate state, shouldBlock() may', () => {
    const cfg = {
      maxDailyLossLamports: 1_000_000_000n,
      maxConsecutiveLosses: 3,
      maxDrawdownPct: 25,
      tripCooldownMs: 0,
    };
    const state = freshState(1_000n);
    state.dayStart = Date.now() - 90_000_000; // > 1 day ago
    state.dailyLossLamports = 500n;

    const breaker = new CircuitBreaker(cfg, state);

    breaker.peek();
    expect(breaker.getState().dailyLossLamports).toBe(500n);
    expect(breaker.getState().dayStart).toBe(state.dayStart);
  });

  it('a loss streak is NOT forgiven by a day roll', () => {
    const cfg = {
      maxDailyLossLamports: 10_000_000_000n,
      maxConsecutiveLosses: 2,
      maxDrawdownPct: 99,
      tripCooldownMs: 0,
    };
    const state = freshState(10_000_000_000n);
    state.consecutiveLosses = 2;
    state.dayStart = Date.now() - 90_000_000;

    const breaker = new CircuitBreaker(cfg, state);
    expect(breaker.shouldBlock().reason).toBe('LOSS_STREAK');
  });
});

// ───────────────────────────────────────────────────────────────────────
// F7 — realised P&L comes from the fill; partial fills stay open
// ───────────────────────────────────────────────────────────────────────

describe('F7: P&L is booked from the actual fill', () => {
  let pm: PositionManager;

  beforeEach(() => {
    pm = new PositionManager(tradingConfig());
  });

  it('uses fill proceeds rather than the quoted exit price', () => {
    const position = pm.openPosition('MintA', 1, 100, 'tx', 1, 0);

    // Quote implied 120 SOL; the fill actually returned 90.
    const closed = pm.closePosition(
      position.id,
      { soldQuantity: 100, proceeds: 90, exitFees: 1, exitTx: 'sell-tx' },
      'take_profit',
    );

    expect(closed.status).toBe('closed');
    // 90 proceeds - 100 cost basis - 1 fee = -11
    expect(closed.netPnl).toBeCloseTo(-11, 9);
    expect(closed.realizedPnl).toBeCloseTo(-11, 9);
  });

  it('keeps a partially filled position OPEN with the residual quantity', () => {
    const position = pm.openPosition('MintA', 1, 100, 'tx', 1, 0);

    const result = pm.closePosition(
      position.id,
      { soldQuantity: 40, proceeds: 50, exitFees: 0 },
      'stop_loss',
    );

    expect(result.status).toBe('open');
    expect(result.quantity).toBeCloseTo(60, 9);
    // Sold 40% of a 100 cost basis for 50 => +10 realised.
    expect(result.netPnl).toBeCloseTo(10, 9);
    expect(pm.getOpenPositions()).toHaveLength(1);
  });

  it('rejects a fill larger than the position', () => {
    const position = pm.openPosition('MintA', 1, 10, 'tx', 1, 0);
    expect(() =>
      pm.closePosition(position.id, { soldQuantity: 11, proceeds: 5 }, 'stop_loss'),
    ).toThrow(/exceeds position quantity/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// F11 — a frozen price must not silently disable stop-losses
// ───────────────────────────────────────────────────────────────────────

describe('F11: stale price handling', () => {
  it('reports a position as stale once past maxPriceAgeMs', () => {
    const pm = new PositionManager(tradingConfig({ maxPriceAgeMs: 1_000 }));
    const position = pm.openPosition('MintA', 1, 10, 'tx', 1, 0);

    expect(pm.isPriceStale(position.id, 1_000, Date.now())).toBe(false);
    expect(pm.isPriceStale(position.id, 1_000, Date.now() + 5_000)).toBe(true);
  });

  it('force-exits rather than evaluating exits on a dead feed', async () => {
    const cfg = tradingConfig({ maxPriceAgeMs: 5_000 });
    const pm = new PositionManager(cfg);
    const execution = {
      getPrice: vi.fn().mockRejectedValue(new Error('rpc down')),
      quoteSell: vi.fn().mockResolvedValue({
        outputAmount: 9,
        pricePerToken: 0.9,
        priceImpactPct: 1,
        route: 'x',
      }),
      buildSellTransaction: vi.fn((q: unknown) => Promise.resolve(q)),
      signAndSendTransaction: vi.fn((q: any) =>
        Promise.resolve({
          signature: 'sell',
          status: 'confirmed',
          error: null,
          fees: 0,
          filledInputAmount: q?.inputAmount,
          filledOutputAmount: q?.outputAmount,
        }),
      ),
    };

    const engine = new MayhemEngine(cfg, pm, execution, {}, silentLogger());

    const position = pm.openPosition('MintA', 1, 10, 'tx', 1, 0);

    // Age the price past tolerance explicitly. Relying on wall-clock drift
    // (maxPriceAgeMs: 0) made this pass or fail depending on whether the
    // millisecond ticked over between openPosition and monitorPositions.
    position.priceAsOf = Date.now() - 60_000;

    await engine.monitorPositions();

    expect(execution.signAndSendTransaction).toHaveBeenCalled();
    expect(pm.getOpenPositions()).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// F15 — one risk threshold, from config
// ───────────────────────────────────────────────────────────────────────

describe('F15: entry risk threshold comes from config', () => {
  it('rejects a score below minRiskScore (not the old hardcoded 30)', () => {
    const cfg = tradingConfig({ minRiskScore: 80 });
    const engine = new MayhemEngine(cfg, new PositionManager(cfg), {}, {}, silentLogger());

    expect(engine.evaluateToken('MintA', 1, 100, 50)).toBeNull();
    expect(engine.evaluateToken('MintA', 1, 100, 80)).not.toBeNull();
  });

  it('applies the configured liquidity participation cap', () => {
    const cfg = tradingConfig({
      maxPositionSol: 100,
      maxLiquidityParticipationBps: 100, // 1%
    });
    const engine = new MayhemEngine(cfg, new PositionManager(cfg), {}, {}, silentLogger());

    const signal = engine.evaluateToken('MintA', 1, 1_000, 90);
    expect(signal!.amount).toBeCloseTo(10, 9); // 1% of 1000
  });
});

// ───────────────────────────────────────────────────────────────────────
// C1 — unmeasurable liquidity must not fall back to full size
// ───────────────────────────────────────────────────────────────────────

describe('C1: entry fails closed when liquidity is unknown', () => {
  const unknownLiquidity: Array<[string, number]> = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  for (const [label, liquidity] of unknownLiquidity) {
    it(`skips the signal when liquidity is ${label}`, () => {
      const cfg = tradingConfig({
        maxPositionSol: 100,
        maxLiquidityParticipationBps: 100,
      });
      const engine = new MayhemEngine(cfg, new PositionManager(cfg), {}, {}, silentLogger());

      expect(engine.evaluateToken('MintA', 1, liquidity, 90)).toBeNull();
    });
  }

  it('still sizes normally when liquidity is measurable', () => {
    const cfg = tradingConfig({
      maxPositionSol: 100,
      maxLiquidityParticipationBps: 100,
    });
    const engine = new MayhemEngine(cfg, new PositionManager(cfg), {}, {}, silentLogger());

    const signal = engine.evaluateToken('MintA', 1, 5_000, 90);
    expect(signal).not.toBeNull();
    expect(signal!.amount).toBeCloseTo(50, 9); // 1% of 5000
  });

  it('never returns a size exceeding the participation cap', () => {
    const cfg = tradingConfig({
      maxPositionSol: 100,
      maxLiquidityParticipationBps: 100,
    });
    const engine = new MayhemEngine(cfg, new PositionManager(cfg), {}, {}, silentLogger());

    // Thin pool: the cap, not maxPositionSol, must bind.
    const signal = engine.evaluateToken('MintA', 1, 200, 90);
    expect(signal!.amount).toBeCloseTo(2, 9);
    expect(signal!.amount).toBeLessThan(cfg.maxPositionSol);
  });
});

// ───────────────────────────────────────────────────────────────────────
// F18 — positions survive a restart
// ───────────────────────────────────────────────────────────────────────

describe('F18: open positions are durable', () => {
  it('restores open positions and forces a price refresh', async () => {
    let saved: any[] = [];
    const store = {
      loadOpen: async () => saved,
      saveOpen: async (positions: any[]) => {
        saved = positions;
      },
    };

    const pmA = new PositionManager(tradingConfig(), store);
    pmA.openPosition('MintA', 1, 10, 'tx', 1, 0);
    await pmA.flush();

    const pmB = new PositionManager(tradingConfig(), store);
    const { restored } = await pmB.restore();

    expect(restored).toBe(1);
    // noUncheckedIndexedAccess: destructuring yields `| undefined`.
    const position = pmB.getOpenPositions()[0];
    expect(position).toBeDefined();
    expect(position!.tokenMint).toBe('MintA');
    // A restored price is always considered stale until refreshed.
    expect(pmB.isPriceStale(position!.id, 1_000)).toBe(true);
  });

  it('never restores a position stuck in the exiting state', () => {
    const pm = new PositionManager(tradingConfig());
    const position = pm.openPosition('MintA', 1, 10, 'tx', 1, 0);
    pm.markExiting(position.id);

    const round = deserializePosition(serializePosition(pm.getPosition(position.id)!));
    expect(round.status).toBe('open');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Scanner: safety checks veto, they do not merely subtract points
// ───────────────────────────────────────────────────────────────────────

describe('Scanner: critical checks veto the verdict', () => {
  const config: RiskConfig = {
    minLiquiditySol: 1,
    maxTopHolderPercent: 20,
    minHolders: 1,
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    maxDailyLossSol: 1,
    maxExposureSol: 1,
    cooldownMs: 0,
    emergencyStop: false,
  };

  const goodPool = {
    address: 'pool',
    tokenMint: 'MintA',
    liquiditySol: 100,
    liquidityToken: 100,
    price: 1,
    volume24h: 0,
    active: true,
  };

  const token = (over: Partial<Record<string, unknown>> = {}) => ({
    mint: 'MintA',
    name: 'Token',
    symbol: 'TKN',
    decimals: 9,
    supply: 1_000_000,
    mintAuthority: null as string | null,
    freezeAuthority: null as string | null,
    metadata: null,
    ...over,
  });

  it('BLOCKS a token whose mint authority is still live', () => {
    const scanner = new TokenSafetyScanner(config);
    const result = scanner.scan(
      token({ mintAuthority: 'SomeAuthority' }) as any,
      goodPool,
      [{ address: 'a', percentage: 5 }],
    );

    expect(result.level).toBe('BLOCKED');
    expect(result.score).toBe(0);
  });

  it('BLOCKS a token whose freeze authority is still live', () => {
    const scanner = new TokenSafetyScanner(config);
    const result = scanner.scan(
      token({ freezeAuthority: 'SomeAuthority' }) as any,
      goodPool,
      [{ address: 'a', percentage: 5 }],
    );
    expect(result.level).toBe('BLOCKED');
  });

  it('BLOCKS when holder data is missing rather than skipping the check', () => {
    const scanner = new TokenSafetyScanner(config);
    const result = scanner.scan(token() as any, goodPool, undefined);
    expect(result.level).toBe('BLOCKED');
  });

  it('passes a clean token', () => {
    const scanner = new TokenSafetyScanner(config);
    const result = scanner.scan(token() as any, goodPool, [
      { address: 'a', percentage: 5 },
    ]);
    expect(result.level).toBe('SAFE');
    expect(result.score).toBeGreaterThanOrEqual(80);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Execution-result contract
// ───────────────────────────────────────────────────────────────────────

describe('Execution result classification', () => {
  it('treats only "confirmed" as a fill', () => {
    expect(isFilled({ signature: 's', status: 'confirmed' })).toBe(true);
    expect(isFilled({ signature: 's', status: 'pending' })).toBe(false);
    expect(isFilled({ signature: 's', status: 'expired' })).toBe(false);
    expect(isFilled({ signature: 's', status: 'failed' })).toBe(false);
    expect(isFilled(null)).toBe(false);
    expect(isFilled(undefined)).toBe(false);
  });

  it('flags pending/expired as unresolved', () => {
    expect(isUnresolved({ signature: 's', status: 'pending' })).toBe(true);
    expect(isUnresolved({ signature: 's', status: 'expired' })).toBe(true);
    expect(isUnresolved({ signature: 's', status: 'failed' })).toBe(false);
  });
});
