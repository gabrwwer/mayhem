import { PositionManager } from '@mayhem/trading-engine/position-manager';
import { TradingConfig } from '@mayhem/trading-engine/types';

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

describe('PositionManager', () => {
  let pm: PositionManager;

  beforeEach(() => {
    pm = new PositionManager(makeConfig());
  });

  describe('openPosition', () => {
    it('creates a position with correct fields', () => {
      const pos = pm.openPosition('MINT1', 0.001, 1000, 'tx123');

      expect(pos.id).toBeDefined();
      expect(pos.tokenMint).toBe('MINT1');
      expect(pos.entryPrice).toBe(0.001);
      expect(pos.quantity).toBe(1000);
      expect(pos.entryTx).toBe('tx123');
      expect(pos.status).toBe('open');
      expect(pos.unrealizedPnl).toBe(0);
      expect(pos.realizedPnl).toBe(0);
      expect(pos.exitReason).toBeNull();
      expect(pos.stopLoss).toBeCloseTo(0.001 * 0.9);
      expect(pos.takeProfit).toBeCloseTo(0.001 * 1.2);
      expect(pos.trailingStop).toBeCloseTo(0.001 * 0.92);
      expect(pos.trailingStopHighPrice).toBe(0.001);
    });

    it('sets entryTx to null when not provided', () => {
      const pos = pm.openPosition('MINT1', 0.001, 1000);
      expect(pos.entryTx).toBeNull();
    });
  });

  describe('updatePosition', () => {
    it('calculates unrealized P/L correctly', () => {
      const pos = pm.openPosition('M', 1.0, 100);
      const update = pm.updatePosition(pos.id, 1.5);

      expect(update.unrealizedPnl).toBeCloseTo(50); // (1.5-1.0)*100
    });

    it('triggers take-profit when price rises above TP threshold', () => {
      const pos = pm.openPosition('M', 1.0, 100);
      // TP = 1.0 * 1.2 = 1.2
      const update = pm.updatePosition(pos.id, 1.25);
      const tp = update.exitConditions.find(c => c.type === 'take_profit');
      expect(tp!.triggered).toBe(true);
    });

    it('triggers stop-loss when price drops below SL threshold', () => {
      const pos = pm.openPosition('M', 1.0, 100);
      // SL = 1.0 * 0.9 = 0.9
      const update = pm.updatePosition(pos.id, 0.85);
      const sl = update.exitConditions.find(c => c.type === 'stop_loss');
      expect(sl!.triggered).toBe(true);
    });

    it('triggers trailing stop correctly (price rises then falls)', () => {
      const pos = pm.openPosition('M', 1.0, 100);
      // price rises to 2.0 -> trailingStopHighPrice=2.0, trailingStop=2.0*0.92=1.84
      pm.updatePosition(pos.id, 2.0);
      // price drops to 1.80 -> below 1.84 trailing stop
      const update = pm.updatePosition(pos.id, 1.80);
      const ts = update.exitConditions.find(c => c.type === 'trailing_stop');
      expect(ts!.triggered).toBe(true);
    });

    it('triggers time exit after max hold seconds', () => {
      const pm2 = new PositionManager(makeConfig({ maxHoldSeconds: 0 }));
      const pos = pm2.openPosition('M', 1.0, 100);
      const update = pm2.updatePosition(pos.id, 1.0);
      const te = update.exitConditions.find(c => c.type === 'time_exit');
      expect(te!.triggered).toBe(true);
    });

    it('throws for unknown position id', () => {
      expect(() => pm.updatePosition('nonexistent', 1.0)).toThrow('not found');
    });
  });

  describe('closePosition', () => {
    // closePosition now takes an actual fill (soldQuantity + proceeds)
    // instead of a quoted exit price — see finding F7. Selling 100 units
    // at 1.5 means proceeds of 150.
    it('sets status to closed and records exit', () => {
      const pos = pm.openPosition('M', 1.0, 100);
      const closed = pm.closePosition(
        pos.id,
        { soldQuantity: 100, proceeds: 150, exitTx: 'exitTx1' },
        'take_profit',
      );

      expect(closed.status).toBe('closed');
      expect(closed.exitReason).toBe('take_profit');
      expect(closed.exitTx).toBe('exitTx1');
      expect(closed.realizedPnl).toBeCloseTo(50);
      expect(closed.unrealizedPnl).toBe(0);
    });

    it('throws for unknown position id', () => {
      expect(() =>
        pm.closePosition('nonexistent', { soldQuantity: 1, proceeds: 1 }, 'x'),
      ).toThrow('not found');
    });
  });

  describe('canOpenPosition', () => {
    it('returns false when at max positions', () => {
      const pm3 = new PositionManager(makeConfig({ maxOpenPositions: 2 }));
      pm3.openPosition('A', 1, 1);
      pm3.openPosition('B', 1, 1);
      expect(pm3.canOpenPosition()).toBe(false);
    });

    it('returns true when under max', () => {
      expect(pm.canOpenPosition()).toBe(true);
    });

    it('frees slot after closing a position', () => {
      const pm3 = new PositionManager(makeConfig({ maxOpenPositions: 1 }));
      const pos = pm3.openPosition('A', 1, 1);
      expect(pm3.canOpenPosition()).toBe(false);
      pm3.closePosition(pos.id, { soldQuantity: 1, proceeds: 1 }, 'manual');
      expect(pm3.canOpenPosition()).toBe(true);
    });
  });

  describe('getOpenPositions', () => {
    it('returns only open positions', () => {
      const p1 = pm.openPosition('A', 1, 1);
      pm.openPosition('B', 1, 1);
      pm.closePosition(p1.id, { soldQuantity: 1, proceeds: 1 }, 'manual');

      const open = pm.getOpenPositions();
      expect(open).toHaveLength(1);
      // noUncheckedIndexedAccess types array access as possibly undefined.
      expect(open[0]?.tokenMint).toBe('B');
    });
  });

  describe('P/L calculations', () => {
    it('profit scenario', () => {
      expect(pm.calculatePnl(1.0, 1.5, 100)).toBeCloseTo(50);
    });

    it('loss scenario', () => {
      expect(pm.calculatePnl(1.0, 0.8, 100)).toBeCloseTo(-20);
    });

    it('break-even', () => {
      expect(pm.calculatePnl(1.0, 1.0, 100)).toBeCloseTo(0);
    });
  });
});