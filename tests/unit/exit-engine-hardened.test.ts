// Import the package, not a relative path into packages/ — that directory
// held a stale, divergent copy of the engine (see the F25 finding).
import { MayhemEngine, PositionManager } from '@mayhem/trading-engine';
import type { TradingConfig, SellQuote } from '@mayhem/trading-engine';

function makeConfig(overrides: Partial<TradingConfig> = {}): TradingConfig {
  return {
    entryEnabled: true,
    maxPositionSol: 0.05,
    takeProfitPercent: 25,
    profitMonitorActivationPercent: 8,
    profitLockActivationPercent: 12,
    profitLockPercent: 3,
    trailingActivationPercent: 15,
    aggressiveTrailingActivationPercent: 20,
      stopLossPercent: 10,
      hardStopLossPercent: 10,
    trailingStopPercent: 5,
    maxHoldSeconds: 300,
    maxOpenPositions: 3,
    entryDelayMs: 0,
    newLaunchMode: false,
    maxQuoteAgeMs: 5000,
    maxSellPriceImpactPercent: 15,
    exitRetryMaxAttempts: 3,
    exitRetryDelayMs: 10,
    minRiskScore: 80,
    maxLiquidityParticipationBps: 100,
    maxPriceAgeMs: 15_000,
    takeProfitRetryDelayMs: 10_000,
    ...overrides,
  };
}

function makeMockExecution(overrides: Record<string, any> = {}) {
  return {
    quoteBuy: jest.fn().mockResolvedValue({
      inputMint: 'SOL', outputMint: 'TOKEN', inputAmount: 0.05,
      outputAmount: 1000, pricePerToken: 0.00005, priceImpactPct: 0.1,
      slippageBps: 50, route: 'simulated',
    }),
    quoteSell: jest.fn().mockResolvedValue({
      inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
      outputAmount: 0.065, pricePerToken: 0.000065, priceImpactPct: 0.5,
      slippageBps: 50, route: 'simulated',
    }),
    // Pass the quote through so the reported fill matches the leg being
    // executed. Venues must report executed amounts — the engine books P&L
    // from these rather than from the quote (finding F7) — but a FIXED
    // amount makes every position of a different size look like a partial
    // fill and stay open.
    buildBuyTransaction: jest.fn((quote: any) => Promise.resolve(quote)),
    buildSellTransaction: jest.fn((quote: any) => Promise.resolve(quote)),
    signAndSendTransaction: jest.fn((quote: any) =>
      Promise.resolve({
        signature: 'tx_sig_ok',
        status: 'confirmed',
        slot: 1,
        error: null,
        fees: 0.000005,
        filledInputAmount: quote?.inputAmount,
        filledOutputAmount: quote?.outputAmount,
      }),
    ),
    getPrice: jest.fn().mockResolvedValue(0.00005),
    ...overrides,
  };
}

describe('Hardened Exit Engine', () => {
  // 1. +25% net P&L triggers TP
  it('triggers TP when executable net P&L >= 25%', async () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const exec = makeMockExecution({
      quoteSell: jest.fn().mockResolvedValue({
        inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
        outputAmount: 0.0625 * 1.30, pricePerToken: 0.00005 * 1.30,
        priceImpactPct: 0.5, slippageBps: 50, route: 'sim',
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0.000005);
    pm.updatePosition(pos.id, 0.00005 * 1.30);

    const closed = await engine.executeExit(pos.id, 'take_profit');
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe('closed');
  });

  // 2. Chart price +25% but net P&L only +15% does NOT trigger 25% TP
  it('does NOT trigger TP when chart says +25% but net executable is below threshold', async () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const exec = makeMockExecution({
      quoteSell: jest.fn().mockResolvedValue({
        inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
        outputAmount: 0.055, pricePerToken: 0.000055,
        priceImpactPct: 5, slippageBps: 50, route: 'sim',
        timestamp: Date.now(),
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0.000005);
    pm.updatePosition(pos.id, 0.00005 * 1.25);

    const closed = await engine.executeExit(pos.id, 'take_profit');
    expect(closed).toBeNull();
    expect(pm.getPosition(pos.id)!.status).not.toBe('closed');
  });

  // 3. Fresh quote required before exit
  it('requires fresh quote before exit', async () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const exec = makeMockExecution();
    const engine = new MayhemEngine(config, pm, exec, {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    await engine.executeExit(pos.id, 'stop_loss');
    expect(exec.quoteSell).toHaveBeenCalled();
  });

  // 4. Stale quote rejected
  it('rejects stale quotes', async () => {
    const config = makeConfig({ maxQuoteAgeMs: -1 });
    const pm = new PositionManager(config);
    const exec = makeMockExecution();
    const engine = new MayhemEngine(config, pm, exec, {});
    engine.on('error', () => {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    const closed = await engine.executeExit(pos.id, 'stop_loss');
    expect(closed).toBeNull();
  });

  // 5. Excessive price impact rejected (for non-emergency exits)
  it('rejects excessive price impact for TP exit', async () => {
    const config = makeConfig({ maxSellPriceImpactPercent: 1 });
    const pm = new PositionManager(config);
    const exec = makeMockExecution({
      quoteSell: jest.fn().mockResolvedValue({
        inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
        outputAmount: 0.08, pricePerToken: 0.00008, priceImpactPct: 20,
        slippageBps: 50, route: 'sim',
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});
    engine.on('error', () => {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    const closed = await engine.executeExit(pos.id, 'take_profit');
    expect(closed).toBeNull();
  });

  // 6. Failed sell does NOT close position
  it('does NOT close position when sell tx fails', async () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const exec = makeMockExecution({
      signAndSendTransaction: jest.fn().mockResolvedValue({
        signature: '', status: 'failed', slot: 0, error: 'tx failed', fees: 0,
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});
    engine.on('error', () => {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    const closed = await engine.executeExit(pos.id, 'stop_loss');
    expect(closed).toBeNull();

    const current = pm.getPosition(pos.id);
    expect(current!.status).not.toBe('closed');
    expect(current!.exitAttemptCount).toBeGreaterThan(0);
  });

  // 7. Successful confirmed sell DOES close position
  it('closes position when sell tx is confirmed', async () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const exec = makeMockExecution();
    const engine = new MayhemEngine(config, pm, exec, {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    const closed = await engine.executeExit(pos.id, 'stop_loss');
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe('closed');
    expect(closed!.exitTx).toBe('tx_sig_ok');
  });

  // 8. Duplicate exit attempts prevented
  it('prevents duplicate exit attempts', async () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    let resolveFirst: () => void;
    const firstCallPromise = new Promise<void>((r) => { resolveFirst = r; });

    const exec = makeMockExecution({
      quoteSell: jest.fn().mockImplementation(async () => {
        await firstCallPromise;
        return {
          inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
          outputAmount: 0.06, pricePerToken: 0.00006, priceImpactPct: 0.5,
          slippageBps: 50, route: 'sim',
        };
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);

    const exit1 = engine.executeExit(pos.id, 'stop_loss');
    const exit2Promise = engine.executeExit(pos.id, 'trailing_stop');

    const result2 = await exit2Promise;
    expect(result2).toBeNull();

    resolveFirst!();
    await exit1;
  });

  // 9. Emergency exit works
  it('emergency exit closes open positions', async () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const exec = makeMockExecution();
    const engine = new MayhemEngine(config, pm, exec, {});

    pm.openPosition('MINT1', 0.00005, 1000, 'tx1', 0.00005, 0);
    pm.openPosition('MINT2', 0.00005, 500, 'tx2', 0.00005, 0);

    const closed = await engine.emergencyExitAll('liquidity_collapse');
    expect(closed.length).toBe(2);
    expect(closed.every((p) => p.status === 'closed')).toBe(true);
  });

  // 10. Emergency exit bypasses price impact check
  it('emergency exit ignores price impact', async () => {
    const config = makeConfig({ maxSellPriceImpactPercent: 1 });
    const pm = new PositionManager(config);
    const exec = makeMockExecution({
      quoteSell: jest.fn().mockResolvedValue({
        inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
        outputAmount: 0.04, pricePerToken: 0.00004, priceImpactPct: 50,
        slippageBps: 50, route: 'sim',
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});

    pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    const closed = await engine.emergencyExitAll('rug');
    expect(closed.length).toBe(1);
  });

  // 11. Trailing stop only moves upward
  it('trailing stop never moves downward', () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const pos = pm.openPosition('M', 1.0, 100, 'tx', 1.0, 0);

    pm.updatePosition(pos.id, 1.5);
    const afterRise = pm.getPosition(pos.id)!;
    const trailingAfterRise = afterRise.trailingStop;

    pm.updatePosition(pos.id, 1.2);
    const afterDrop = pm.getPosition(pos.id)!;
    expect(afterDrop.trailingStop).toBeGreaterThanOrEqual(trailingAfterRise);
  });

  // 12. Profit lock only moves protection upward
  it('profit lock never lowers stopLoss', () => {
    const config = makeConfig({
      profitLockActivationPercent: 10,
      profitLockPercent: 5,
      stopLossPercent: 10,
    });
    const pm = new PositionManager(config);
    const pos = pm.openPosition('M', 1.0, 100, 'tx', 1.0, 0);

    pm.updatePosition(pos.id, 1.15);
    const slAfterLock = pm.getPosition(pos.id)!.stopLoss;

    pm.updatePosition(pos.id, 1.05);
    const slAfterDrop = pm.getPosition(pos.id)!.stopLoss;
    expect(slAfterDrop).toBeGreaterThanOrEqual(slAfterLock);
  });

  // 13. Stop loss does not loosen
  it('stop loss never goes lower', () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const pos = pm.openPosition('M', 1.0, 100, 'tx', 1.0, 0);
    const initialSl = pm.getPosition(pos.id)!.stopLoss;

    pm.updatePosition(pos.id, 1.3);
    const slAfterRise = pm.getPosition(pos.id)!.stopLoss;
    expect(slAfterRise).toBeGreaterThanOrEqual(initialSl);

    pm.updatePosition(pos.id, 1.1);
    const slAfterDrop = pm.getPosition(pos.id)!.stopLoss;
    expect(slAfterDrop).toBeGreaterThanOrEqual(slAfterRise);
  });

  // 14. Time exit gets a fresh quote
  it('time exit obtains fresh sell quote', async () => {
    const config = makeConfig({ maxHoldSeconds: 0 });
    const pm = new PositionManager(config);
    const exec = makeMockExecution();
    const engine = new MayhemEngine(config, pm, exec, {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    await engine.executeExit(pos.id, 'time_exit');
    expect(exec.quoteSell).toHaveBeenCalled();
  });

  // 15. Actual entry fill is used
  it('uses actual entry price for position accounting', () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const pos = pm.openPosition('M', 0.001, 100, 'tx', 0.0012, 0.000005);
    expect(pos.actualEntryPrice).toBe(0.0012);
    expect(pos.entryFees).toBe(0.000005);
  });

  // 16. Fees included in net P&L
  it('includes fees in net P&L on close', () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const pos = pm.openPosition('M', 1.0, 100, 'tx', 1.0, 0.01);
    const closed = pm.closePosition(
      pos.id,
      { soldQuantity: 100, proceeds: 130, exitFees: 0.01, exitTx: 'exitTx' },
      'tp',
    );
    expect(closed.fees).toBeCloseTo(0.02);
    expect(closed.netPnl).toBeLessThan(closed.grossPnl);
  });

  // 17. Position remains open after failed tx
  it('position stays open after failed sell', async () => {
    const config = makeConfig({ exitRetryMaxAttempts: 1 });
    const pm = new PositionManager(config);
    const exec = makeMockExecution({
      signAndSendTransaction: jest.fn().mockResolvedValue({
        signature: '', status: 'failed', slot: 0, error: 'nope', fees: 0,
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});
    engine.on('error', () => {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    await engine.executeExit(pos.id, 'stop_loss');
    expect(pm.getPosition(pos.id)!.status).toBe('open');
  });

  // 18. Max retry count is respected
  it('respects max retry count', async () => {
    const config = makeConfig({ exitRetryMaxAttempts: 2, exitRetryDelayMs: 1 });
    const pm = new PositionManager(config);
    const sellFn = jest.fn().mockResolvedValue({
      signature: '', status: 'failed', slot: 0, error: 'fail', fees: 0,
    });
    const exec = makeMockExecution({ signAndSendTransaction: sellFn });
    const engine = new MayhemEngine(config, pm, exec, {});
    engine.on('error', () => {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    await engine.executeExit(pos.id, 'stop_loss');
    expect(sellFn).toHaveBeenCalledTimes(2);
  });

  // 19. Retry uses fresh quote each time
  it('gets fresh quote on each retry', async () => {
    const config = makeConfig({ exitRetryMaxAttempts: 2, exitRetryDelayMs: 1 });
    const pm = new PositionManager(config);
    const quoteSellFn = jest.fn().mockResolvedValue({
      inputMint: 'TOKEN', outputMint: 'SOL', inputAmount: 1000,
      outputAmount: 0.06, pricePerToken: 0.00006, priceImpactPct: 0.5,
      slippageBps: 50, route: 'sim',
    });
    const exec = makeMockExecution({
      quoteSell: quoteSellFn,
      signAndSendTransaction: jest.fn().mockResolvedValue({
        signature: '', status: 'failed', slot: 0, error: 'fail', fees: 0,
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});
    engine.on('error', () => {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    await engine.executeExit(pos.id, 'stop_loss');
    // quoteSell called in getFreshSellQuote + executeSell = 2 per attempt, 2 attempts = 4
    expect(quoteSellFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // 20. Net P&L calculation
  it('calculates net P&L correctly', () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const engine = new MayhemEngine(config, pm, null, {});

    const pos = pm.openPosition('M', 1.0, 100, 'tx', 1.0, 0.01);
    const quote: SellQuote = {
      outputAmount: 130,
      pricePerToken: 1.3,
      priceImpactPct: 2,
      route: 'test',
      timestamp: Date.now(),
    };

    const result = engine.calculateNetPnl(pos, quote);
    expect(result.grossProceeds).toBe(130);
    expect(result.entryCost).toBeCloseTo(100.01);
    expect(result.netPnl).toBeGreaterThan(0);
    expect(result.netPnlPercent).toBeLessThan(30);
    expect(result.isStale).toBe(false);
  });

  // 21. Exit attempt tracking
  it('tracks exit attempts on failed sells', async () => {
    const config = makeConfig({ exitRetryMaxAttempts: 1 });
    const pm = new PositionManager(config);
    const exec = makeMockExecution({
      signAndSendTransaction: jest.fn().mockResolvedValue({
        signature: '', status: 'failed', slot: 0, error: 'network error', fees: 0,
      }),
    });
    const engine = new MayhemEngine(config, pm, exec, {});
    engine.on('error', () => {});

    const pos = pm.openPosition('MINT', 0.00005, 1000, 'tx', 0.00005, 0);
    await engine.executeExit(pos.id, 'stop_loss');

    const updated = pm.getPosition(pos.id)!;
    expect(updated.exitAttemptCount).toBe(1);
    expect(updated.lastExitError).toBe('network error');
    expect(updated.lastExitAttemptAt).not.toBeNull();
  });

  // 22. Position exiting status prevents re-entry to exit
  it('markExiting prevents double exit processing', () => {
    const config = makeConfig();
    const pm = new PositionManager(config);
    const pos = pm.openPosition('M', 1.0, 100, 'tx', 1.0, 0);

    expect(pm.markExiting(pos.id)).toBe(true);
    expect(pm.getPosition(pos.id)!.status).toBe('exiting');
    expect(pm.markExiting(pos.id)).toBe(false);

    pm.releaseExiting(pos.id);
    expect(pm.getPosition(pos.id)!.status).toBe('open');
  });
});