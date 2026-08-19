import { LiquidityMonitor } from '../../packages/token-monitor/src/liquidity-monitor';

describe('LiquidityMonitor', () => {
  let monitor: LiquidityMonitor;
  const mockConnection = {
    getConnection: jest.fn().mockReturnValue({
      getAccountInfo: jest.fn().mockResolvedValue(null),
    }),
  };

  beforeEach(() => {
    monitor = new LiquidityMonitor(mockConnection as any, {
      pollIntervalMs: 100,
      liquidityDropExitPercent: 40,
      maxPriceDropPercent: 15,
      creatorSellDetection: true,
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  test('watchPool adds pool to monitoring', () => {
    monitor.watchPool('POOL1', 'MINT1', 100);
    expect(monitor.getWatchedPools()).toContain('POOL1');
  });

  test('unwatchPool removes pool', () => {
    monitor.watchPool('POOL1', 'MINT1', 100);
    monitor.unwatchPool('POOL1');
    expect(monitor.getWatchedPools()).not.toContain('POOL1');
  });

  test('fires alert when liquidity drops below threshold', () => {
    const alertHandler = jest.fn();
    monitor.onAlert(alertHandler);
    monitor.watchPool('POOL1', 'MINT1', 100);
    monitor.simulateLiquidityChange('POOL1', 50);
    expect(alertHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        poolAddress: 'POOL1',
        alertType: 'liquidity_drop',
        severity: 'critical',
      }),
    );
  });

  test('does not fire alert for small fluctuation', () => {
    const alertHandler = jest.fn();
    monitor.onAlert(alertHandler);
    monitor.watchPool('POOL1', 'MINT1', 100);
    monitor.simulateLiquidityChange('POOL1', 90);
    expect(alertHandler).not.toHaveBeenCalled();
  });

  test('multiple pools monitored simultaneously', () => {
    monitor.watchPool('POOL1', 'MINT1', 100);
    monitor.watchPool('POOL2', 'MINT2', 200);
    expect(monitor.getWatchedPools()).toHaveLength(2);
  });
});