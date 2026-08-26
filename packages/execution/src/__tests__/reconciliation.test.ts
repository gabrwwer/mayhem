import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { OrderReconciliationService, ReconciliationResult } from '../reconciliation';
import { EngineStateRepository, PersistedOrder, UNRESOLVED_ORDERS_KEY } from '@mayhem/database';
import { JitoClient } from '../jito';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('OrderReconciliationService', () => {
  let service: OrderReconciliationService;
  let mockRepo: any;
  let mockJito: any;
  let mockConn: any;
  let mockDb: any;

  beforeEach(() => {
    mockRepo = {
      get: vi.fn(),
      put: vi.fn(),
    };
    mockJito = {
      bundleStatus: vi.fn(),
      bundleDetails: vi.fn(),
    };
    mockConn = {} as Connection;
    mockDb = {
      query: vi.fn(),
    };

    service = new OrderReconciliationService(
      mockConn,
      mockJito as any,
      mockDb,
      mockRepo as any,
      mockLogger as any,
      5_000,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty result when no orders to reconcile', async () => {
    mockRepo.get.mockResolvedValue(null);

    const result = await service.reconcileOnStartup();

    expect(result.ordersChecked).toBe(0);
    expect(result.ordersReconciled).toBe(0);
    expect(result.bundlesInFlight).toHaveLength(0);
    expect(result.orphanedPositions).toHaveLength(0);
  });

  it('should reconcile landed bundles', async () => {
    const order: PersistedOrder = {
      orderId: 'order-1',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'buy',
      state: 'submitted',
      placedAt: Date.now(),
      bundleId: 'bundle-1',
      requestedQuantity: '1000',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    mockRepo.get.mockResolvedValue({ 'order-1': order });
    mockJito.bundleStatus.mockResolvedValue('Landed');

    const result = await service.reconcileOnStartup();

    expect(result.ordersChecked).toBe(1);
    expect(result.ordersReconciled).toBe(1);
    expect(result.bundlesInFlight).toHaveLength(1);
    expect(result.bundlesInFlight[0]?.status).toBe('Landed');

    const savedOrders = mockRepo.put.mock.calls[0][1];
    expect(savedOrders['order-1'].state).toBe('confirmed');
    expect(savedOrders['order-1'].reconciliationState).toBe('reconciled');
  });

  it('should mark invalid bundles as failed', async () => {
    const order: PersistedOrder = {
      orderId: 'order-2',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'sell',
      state: 'submitted',
      placedAt: Date.now(),
      bundleId: 'bundle-2',
      requestedQuantity: '500',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    mockRepo.get.mockResolvedValue({ 'order-2': order });
    mockJito.bundleStatus.mockResolvedValue('Invalid');

    const result = await service.reconcileOnStartup();

    const savedOrders = mockRepo.put.mock.calls[0][1];
    expect(savedOrders['order-2'].state).toBe('failed');
    expect(savedOrders['order-2'].reconciliationState).toBe('reconciled');
  });

  it('should detect orphaned orders (no bundle ID)', async () => {
    const orphanedOrder: PersistedOrder = {
      orderId: 'orphan-1',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'buy',
      state: 'submitted',
      placedAt: Date.now(),
      requestedQuantity: '1000',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    mockRepo.get.mockResolvedValue({ 'orphan-1': orphanedOrder });

    const result = await service.reconcileOnStartup();

    expect(result.orphanedPositions).toContain('orphan-1');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Orphaned order detected',
      expect.objectContaining({ orderId: 'orphan-1' }),
    );
  });

  it('should timeout gracefully', async () => {
    const order: PersistedOrder = {
      orderId: 'order-slow',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'buy',
      state: 'submitted',
      placedAt: Date.now(),
      bundleId: 'bundle-slow',
      requestedQuantity: '1000',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    mockRepo.get.mockResolvedValue({ 'order-slow': order });
    mockJito.bundleStatus.mockImplementation(
      () => new Promise(r => setTimeout(r, 10_000)),
    );

    const result = await service.reconcileOnStartup();

    expect(result.durationMs).toBeLessThan(6_000);
  }, 7_000);

  it('should handle bundle status check errors gracefully', async () => {
    const order: PersistedOrder = {
      orderId: 'order-error',
      mint: 'EPjFWaJwhUmzV6KXNgqKXPsqJZJLrZmFnLKHqCWZj8d',
      side: 'buy',
      state: 'submitted',
      placedAt: Date.now(),
      bundleId: 'bundle-error',
      requestedQuantity: '1000',
      retryCount: 0,
      reconciliationState: 'unreconciled',
    };

    mockRepo.get.mockResolvedValue({ 'order-error': order });
    mockJito.bundleStatus.mockRejectedValue(new Error('API error'));

    const result = await service.reconcileOnStartup();

    expect(result.ordersChecked).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to check bundle status',
      expect.objectContaining({ bundleId: 'bundle-error' }),
    );
  });

  it('should log reconciliation result to database', async () => {
    const result: ReconciliationResult = {
      timestamp: Date.now(),
      ordersChecked: 5,
      ordersReconciled: 3,
      bundlesInFlight: [
        {
          bundleId: 'bundle-1',
          status: 'Landed',
          ordersInBundle: ['order-1'],
          lastCheckedAt: Date.now(),
        },
      ],
      orphanedPositions: ['orphan-1'],
      durationMs: 1000,
    };

    await service.logReconciliation(result);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO reconciliation_log'),
      expect.any(Array),
    );

    const queryArgs = mockDb.query.mock.calls[0][1];
    expect(queryArgs[1]).toBe(result.ordersChecked);
    expect(queryArgs[2]).toBe(result.ordersReconciled);
  });
});
