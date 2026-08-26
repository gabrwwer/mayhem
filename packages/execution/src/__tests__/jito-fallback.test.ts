import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { JitoClient } from '../jito';

describe('JitoClient Fallback & Retry', () => {
  let jito: JitoClient;

  beforeEach(() => {
    jito = new JitoClient('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
      retries: 3,
      backoffMs: 50,
      timeoutMs: 1000,
      tipAccountsTtlMs: 5000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should return cached accounts if fresh', async () => {
    const mockAccounts = ['HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn'];
    vi.spyOn(jito as any, 'rpc').mockResolvedValue(mockAccounts);

    const firstCall = await jito.tipAccounts();
    expect(firstCall).toHaveLength(1);
    expect(firstCall[0] instanceof PublicKey).toBe(true);

    // Second call should use cache without RPC call
    const rpcCallCount = vi.fn();
    vi.spyOn(jito as any, 'rpc').mockImplementation(async () => {
      rpcCallCount();
      return [];
    });

    const secondCall = await jito.tipAccounts();
    expect(secondCall).toEqual(firstCall);
    expect(rpcCallCount).not.toHaveBeenCalled(); // Cache hit
  });

  it('should retry on transient failures', async () => {
    let attempts = 0;
    vi.spyOn(jito as any, 'rpc').mockImplementation(async (...args: unknown[]): Promise<unknown> => {
      const method = args[0];
      if (method === 'getTipAccounts') {
        attempts++;
        if (attempts < 2) throw new Error('Transient error');
        return ['HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn'];
      }
      return [];
    });

    const accounts = await jito.tipAccounts();

    expect(attempts).toBe(2); // Failed once, succeeded on retry
    expect(accounts).toHaveLength(1);
    expect(jito.getTipAccountsLastError()).toBeNull(); // Error cleared on success
  });

  it('should use stale cache on persistent failure', async () => {
    // First call succeeds
    vi.spyOn(jito as any, 'rpc').mockResolvedValue([
      'HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn',
    ]);

    const firstCall = await jito.tipAccounts();
    expect(firstCall).toHaveLength(1);

    // Advance time past TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(65_000);

    // Second call fails but returns stale cache
    vi.spyOn(jito as any, 'rpc').mockRejectedValue(new Error('API down'));

    const secondCallPromise = jito.tipAccounts();
    await vi.advanceTimersByTimeAsync(1_000);
    const secondCall = await secondCallPromise;

    expect(secondCall).toHaveLength(1); // Still cached
    expect(jito.getTipAccountsLastError()?.message).toContain('API down');

    vi.useRealTimers();
  });

  it('should fall back to hardcoded accounts when cache expired', async () => {
    // All retries fail
    vi.spyOn(jito as any, 'rpc').mockRejectedValue(new Error('API down for 5 minutes'));

    const accounts = await jito.tipAccounts();

    // Should have fallback accounts
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0] instanceof PublicKey).toBe(true);
    expect(jito.getTipAccountsLastError()).toBeTruthy();
  });

  it('should reject empty account list', async () => {
    vi.spyOn(jito as any, 'rpc').mockResolvedValue([]);

    // Should retry and eventually fall back
    const accounts = await jito.tipAccounts();

    expect(accounts.length).toBeGreaterThan(0); // Fallback triggered
    expect(jito.getTipAccountsLastError()).toBeTruthy();
  });

  it('should expose last error for monitoring', async () => {
    vi.spyOn(jito as any, 'rpc').mockRejectedValue(new Error('API error'));

    const accounts = await jito.tipAccounts();
    const error = jito.getTipAccountsLastError();

    expect(accounts.length).toBeGreaterThan(0); // Fallback succeeded
    expect(error).toBeTruthy();
    expect(error?.message).toContain('API error');
  });

  it('should clear error on successful fetch', async () => {
    // First fail
    const rpc = vi.spyOn(jito as any, 'rpc');
    rpc.mockRejectedValue(new Error('API error'));
    await jito.tipAccounts();
    expect(jito.getTipAccountsLastError()).toBeTruthy();

    // Then succeed
    vi.useFakeTimers();
    vi.advanceTimersByTime(65_000); // Past TTL
    vi.useRealTimers();

    rpc.mockResolvedValue([
      'HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn',
    ]);

    await jito.tipAccounts();
    expect(jito.getTipAccountsLastError()).toBeNull(); // Error cleared
  });
});
