
import { PositionManager } from '../position-manager';
import { TradingConfig } from '../types';

const BASE_CONFIG: TradingConfig = {
  entryEnabled: true,
  maxPositionSol: 10,
  takeProfitPercent: 200,
  profitMonitorActivationPercent: 0,
  profitLockActivationPercent: 15,
  profitLockPercent: 10,
  trailingActivationPercent: 0,
  aggressiveTrailingActivationPercent: 0,
  stopLossPercent: 10,
  hardStopLossPercent: 10,
  trailingStopPercent: 50,
  maxHoldSeconds: 3600,
  maxOpenPositions: 10,
  entryDelayMs: 0,
  newLaunchMode: true,
  maxQuoteAgeMs: 5000,
  maxSellPriceImpactPercent: 10,
  exitRetryMaxAttempts: 3,
  exitRetryDelayMs: 100,
  minRiskScore: 80,
  maxLiquidityParticipationBps: 100,
  maxPriceAgeMs: 15_000,
  takeProfitRetryDelayMs: 10_000,
};

function createManager(overrides?: Partial<TradingConfig>): PositionManager {
  return new PositionManager({ ...BASE_CONFIG, ...overrides });
}

function openAt(manager: PositionManager, entryPrice = 100) {
  return manager.openPosition(
    'TEST_MINT',
    entryPrice,
    1,
    undefined,
    entryPrice,
    0,
    1000,
  );
}

function priceAtPercent(entry: number, pct: number) {
  return entry * (1 + pct / 100);
}

describe('MAYHEM LOCK LADDER V4', () => {
  // 1. +0% => initial stop unchanged
  test('no change at 0% profit', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, 100);
    expect(p.stopLoss).toBeCloseTo(90, 8);
    expect(p.profitLockActive).toBe(false);
  });

  // 2. +14.99% => no lock
  test('no lock at +14.99%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 14.99));
    expect(p.profitLockActive).toBe(false);
    expect(p.stopLoss).toBeCloseTo(90, 8);
  });

  // 3. +15% => +10% lock
  test('+15% locks +10%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 15));
    expect(p.profitLockActive).toBe(true);
    expect(p.stopLoss).toBeCloseTo(110, 8);
  });

  // 4. +20% => +15% lock
  test('+20% locks +15%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 20));
    expect(p.stopLoss).toBeCloseTo(115, 8);
  });

  // 5. +25% => +20% lock
  test('+25% locks +20%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 25));
    expect(p.stopLoss).toBeCloseTo(120, 8);
  });

  // 6. +35% => +27% lock
  test('+35% locks +27%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 35));
    expect(p.stopLoss).toBeCloseTo(127, 8);
  });

  // 7. +50% => +40% lock
  test('+50% locks +40%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 50));
    expect(p.stopLoss).toBeCloseTo(140, 8);
  });

  // 8. +75% => +60% lock
  test('+75% locks +60%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 75));
    expect(p.stopLoss).toBeCloseTo(160, 8);
  });

  // 9. +100% => +80% lock
  test('+100% locks +80%', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 100));
    expect(p.stopLoss).toBeCloseTo(180, 8);
  });

  // 10. price rises then falls => lock remains
  test('lock remains after price pullback', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 50));
    expect(p.stopLoss).toBeCloseTo(140, 8);
    m.updatePosition(p.id, priceAtPercent(100, 20));
    expect(p.stopLoss).toBeGreaterThanOrEqual(140 - 1e-8);
  });

  // 11. trailing cannot lower ladder lock
  test('trailing cannot lower established ladder lock', () => {
    const m = createManager({ trailingStopPercent: 50 });
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 50));
    const lockAfter50 = p.stopLoss;
    m.updatePosition(p.id, priceAtPercent(100, 16));
    expect(p.stopLoss).toBeGreaterThanOrEqual(lockAfter50 - 1e-8);
  });

  // 12. repeated updatePosition() calls are idempotent
  test('idempotent updates', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 35));
    const stop1 = p.stopLoss;
    m.updatePosition(p.id, priceAtPercent(100, 35));
    expect(p.stopLoss).toBe(stop1);
  });

  // 13. actualEntryPrice is used, not entryPrice
  test('uses actualEntryPrice for lock calculation', () => {
    const m = createManager();
    const p = m.openPosition('TEST', 80, 1, undefined, 100, 0);
    expect(p.entryPrice).toBe(80);
    expect(p.actualEntryPrice).toBe(100);
    m.updatePosition(p.id, priceAtPercent(100, 15));
    expect(p.stopLoss).toBeCloseTo(110, 8);
  });

  // 14. signal price vs actual price doesn't corrupt locks
  test('signal price divergence does not corrupt locks', () => {
    const m = createManager();
    const p = m.openPosition('TEST', 50, 1, undefined, 100, 0);
    m.updatePosition(p.id, priceAtPercent(100, 25));
    expect(p.stopLoss).toBeCloseTo(120, 8);
  });

  test('records the full price lifecycle without losing execution semantics', () => {
    const m = createManager();
    const p = m.openPosition('TEST', 52, 1, 'tx1', 50, 0);

    expect(p.observationPrice).toBe(52);
    expect(p.signalPrice).toBe(52);
    expect(p.qualifiedEntryPrice).toBe(52);
    expect(p.actualEntryPrice).toBe(50);
    expect(p.executionPrice).toBe(50);
    expect(p.entryPrice).toBe(52);

    m.updatePosition(p.id, priceAtPercent(50, 15));
    expect(p.stopLoss).toBeCloseTo(55, 8);
  });

  test('progressive ladder ascent', () => {
    const m = createManager();
    const p = openAt(m);

    m.updatePosition(p.id, priceAtPercent(100, 15));
    expect(p.stopLoss).toBeCloseTo(110, 8);

    m.updatePosition(p.id, priceAtPercent(100, 25));
    expect(p.stopLoss).toBeCloseTo(120, 8);

    m.updatePosition(p.id, priceAtPercent(100, 50));
    expect(p.stopLoss).toBeCloseTo(140, 8);

    m.updatePosition(p.id, priceAtPercent(100, 100));
    expect(p.stopLoss).toBeCloseTo(180, 8);
  });

  test('old +10% lock does not exist', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 10));
    expect(p.profitLockActive).toBe(false);
  });

  test('highestLockPercent tracks correctly', () => {
    const m = createManager();
    const p = openAt(m);
    m.updatePosition(p.id, priceAtPercent(100, 35));
    expect(p.highestLockPercent).toBe(27);
    m.updatePosition(p.id, priceAtPercent(100, 20));
    expect(p.highestLockPercent).toBe(27);
  });
});

describe('P&L calculations', () => {
  // closePosition now takes an actual FILL (soldQuantity + proceeds) rather
  // than a quoted exit price — see the F7 finding. `proceeds` is what the
  // sell actually returned, so the equivalent of "exit at 150 with qty 1"
  // is proceeds = 150.

  // 15. correct gross P&L
  test('gross P&L is proceeds - cost basis', () => {
    const m = createManager();
    const p = openAt(m, 100);
    const closed = m.closePosition(
      p.id,
      { soldQuantity: 1, proceeds: 150, exitFees: 0, exitTx: 'tx1' },
      'take_profit',
    );
    expect(closed.grossPnl).toBeCloseTo(50, 8);
  });

  // 16-17. correct fee handling
  test('entry + exit fees both subtracted from net P&L', () => {
    const m = createManager();
    const p = m.openPosition('TEST', 100, 1, undefined, 100, 0.5);
    const closed = m.closePosition(
      p.id,
      { soldQuantity: 1, proceeds: 150, exitFees: 0.3, exitTx: 'tx1' },
      'take_profit',
    );
    expect(closed.fees).toBeCloseTo(0.8, 8);
    // entryNotional = 100*1 + 0.5 = 100.5; net = 150 - 100.5 - 0.3
    expect(closed.netPnl).toBeCloseTo(150 - 100.5 - 0.3, 8);
  });

  // 18-19. no double fee subtraction
  test('no double fee subtraction', () => {
    const m = createManager();
    const p = m.openPosition('TEST', 100, 1, undefined, 100, 1.0);
    const closed = m.closePosition(
      p.id,
      { soldQuantity: 1, proceeds: 200, exitFees: 1.0, exitTx: 'tx' },
      'tp',
    );
    // entryNotional = 101 (includes the 1.0 entry fee, counted ONCE)
    expect(closed.netPnl).toBeCloseTo(200 - 101 - 1.0, 8);
    expect(closed.fees).toBeCloseTo(2.0, 8);
  });

  // 20. no double price-impact subtraction (N/A at position manager level)
});

describe('Exit conditions', () => {
  // 23-26. stop/trailing/time bypasses TP (tested via engine, but verify conditions trigger)
  test('stop loss triggers when price <= stopLoss', () => {
    const m = createManager({ stopLossPercent: 10 });
    const p = openAt(m, 100);
    const update = m.updatePosition(p.id, 89);
    const sl = update.exitConditions.find(c => c.type === 'stop_loss');
    expect(sl?.triggered).toBe(true);
  });

  test('take profit triggers when price >= takeProfit', () => {
    const m = createManager({ takeProfitPercent: 100 });
    const p = openAt(m, 100);
    const update = m.updatePosition(p.id, 200);
    const tp = update.exitConditions.find(c => c.type === 'take_profit');
    expect(tp?.triggered).toBe(true);
  });

  // 27-34. exit retries â€” tested in engine tests
});

describe('Entry validation', () => {
  // 35-40
  test('rejects invalid entry price', () => {
    const m = createManager();
    expect(() => m.openPosition('T', 0, 1)).toThrow();
    expect(() => m.openPosition('T', -1, 1)).toThrow();
    expect(() => m.openPosition('T', NaN, 1)).toThrow();
  });

  test('rejects invalid quantity', () => {
    const m = createManager();
    expect(() => m.openPosition('T', 100, 0)).toThrow();
    expect(() => m.openPosition('T', 100, -5)).toThrow();
  });

  test('rejects when max positions reached', () => {
    const m = createManager({ maxOpenPositions: 1 });
    openAt(m);
    expect(() => openAt(m)).toThrow(/Maximum open positions/);
  });
});

describe('Trailing stop', () => {
  // 41. trailing activation before +15% is impossible
  test('trailing does not activate before +15%', () => {
    const m = createManager({ trailingActivationPercent: 0 });
    const p = openAt(m, 100);
    m.updatePosition(p.id, priceAtPercent(100, 10));
    expect(p.trailingStop).toBe(0);
  });

  // 42. high-water mark only increases
  test('high-water mark only increases', () => {
    const m = createManager();
    const p = openAt(m, 100);
    m.updatePosition(p.id, priceAtPercent(100, 20));
    const hwm1 = p.trailingStopHighPrice;
    m.updatePosition(p.id, priceAtPercent(100, 16));
    expect(p.trailingStopHighPrice).toBeGreaterThanOrEqual(hwm1);
  });

  // 43. trailing stop only increases
  test('trailing stop only increases', () => {
    const m = createManager();
    const p = openAt(m, 100);
    m.updatePosition(p.id, priceAtPercent(100, 50));
    const ts1 = p.trailingStop;
    m.updatePosition(p.id, priceAtPercent(100, 20));
    expect(p.trailingStop).toBeGreaterThanOrEqual(ts1);
  });

  // 44. trailing cannot lower ladder stop
  test('trailing cannot lower ladder stop', () => {
    const m = createManager({ trailingStopPercent: 50 });
    const p = openAt(m, 100);
    m.updatePosition(p.id, priceAtPercent(100, 75));
    expect(p.stopLoss).toBeCloseTo(160, 8);
    m.updatePosition(p.id, priceAtPercent(100, 16));
    expect(p.stopLoss).toBeGreaterThanOrEqual(160 - 1e-8);
  });

  test('trailing stop does not trigger when trailingStop is 0', () => {
    const m = createManager();
    const p = openAt(m, 100);
    m.updatePosition(p.id, 90);
    const update = m.updatePosition(p.id, 90);
    const ts = update.exitConditions.find(c => c.type === 'trailing_stop');
    expect(ts?.triggered).toBe(false);
  });
});

describe('closePosition P&L', () => {
  test('netPnlPercent is relative to entryNotional', () => {
    const m = createManager();
    const p = m.openPosition('TEST', 100, 10, undefined, 100, 1);
    // entryNotional = 100*10 + 1 = 1001
    const closed = m.closePosition(
      p.id,
      { soldQuantity: 10, proceeds: 1100, exitFees: 1, exitTx: 'tx' },
      'tp',
    );
    // netPnl = 1100 - 1001 - 1 = 98
    expect(closed.netPnl).toBeCloseTo(98, 8);
    expect(closed.netPnlPercent).toBeCloseTo(9.79, 1);
  });

  test('a partial fill leaves the position open with the residual', () => {
    const m = createManager();
    const p = m.openPosition('TEST', 100, 10, undefined, 100, 0);
    const result = m.closePosition(
      p.id,
      { soldQuantity: 4, proceeds: 440 },
      'tp',
    );
    expect(result.status).toBe('open');
    expect(result.quantity).toBeCloseTo(6, 8);
    // Sold 40% of a 1000 basis for 440 => +40 realised.
    expect(result.netPnl).toBeCloseTo(40, 8);
  });
});

describe('Position state management', () => {
  test('markExiting and releaseExiting', () => {
    const m = createManager();
    const p = openAt(m);
    expect(m.markExiting(p.id)).toBe(true);
    expect(p.status).toBe('exiting');
    m.releaseExiting(p.id);
    expect(p.status).toBe('open');
  });

  test('cannot mark closed position as exiting', () => {
    const m = createManager();
    const p = openAt(m);
    m.closePosition(p.id, { soldQuantity: 1, proceeds: 100 }, 'test');
    expect(m.markExiting(p.id)).toBe(false);
  });

  test('closed position cannot be closed again (idempotent)', () => {
    const m = createManager();
    const p = openAt(m);
    m.closePosition(p.id, { soldQuantity: 1, proceeds: 110 }, 'test');
    const again = m.closePosition(p.id, { soldQuantity: 1, proceeds: 120 }, 'test2');
    expect(again.exitReason).toBe('test');
  });
});