import { describe, it, expect, vi, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  JitoClient,
  AmbiguousSendError,
  RejectedError,
  TransportError,
} from '@mayhem/execution';

import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAMS } from '@mayhem/solana';

/**
 * F3 / F5 / F6 regressions — the duplicate-order and wrong-program-id
 * failure modes. These are the two that lose money without any error
 * appearing in the logs.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

interface ResponseSpec {
  throw?: Error;
  status?: number;
  body?: unknown;
}

function mockFetchSequence(responses: ResponseSpec[]) {
  let call = 0;
  const spy = vi.fn(async () => {
    // noUncheckedIndexedAccess is on, so indexing yields `| undefined`.
    const spec: ResponseSpec =
      responses[Math.min(call, responses.length - 1)] ?? {};
    call += 1;
    if (spec.throw) throw spec.throw;
    return {
      ok: (spec.status ?? 200) < 400,
      status: spec.status ?? 200,
      json: async () => spec.body ?? { result: 'bundle-uuid' },
    } as unknown as Response;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('F3: sendBundle must not re-send after an ambiguous failure', () => {
  it('does NOT retry after a client-side timeout', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';

    const spy = mockFetchSequence([
      { throw: timeout },
      { body: { result: 'bundle-uuid' } },
    ]);

    const client = new JitoClient('https://example.invalid', { retries: 5 });

    await expect(client.sendBundle([])).rejects.toBeInstanceOf(AmbiguousSendError);

    // The critical assertion: exactly ONE send reached the wire. A second
    // call here is a duplicate buy.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a 5xx (the engine may have accepted it)', async () => {
    const spy = mockFetchSequence([{ status: 503 }, { body: { result: 'uuid' } }]);
    const client = new JitoClient('https://example.invalid', { retries: 5 });

    await expect(client.sendBundle([])).rejects.toBeInstanceOf(AmbiguousSendError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a 429', async () => {
    const spy = mockFetchSequence([{ status: 429 }, { body: { result: 'uuid' } }]);
    const client = new JitoClient('https://example.invalid', { retries: 5 });

    await expect(client.sendBundle([])).rejects.toBeInstanceOf(AmbiguousSendError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('DOES retry a definitive rejection (4xx / JSON-RPC error)', async () => {
    const spy = mockFetchSequence([
      { body: { error: { message: 'bad bundle' } } },
      { body: { result: 'bundle-uuid' } },
    ]);

    const client = new JitoClient('https://example.invalid', {
      retries: 3,
      backoffMs: 0,
    });

    await expect(client.sendBundle([])).resolves.toBe('bundle-uuid');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('classifies 4xx as retryable rejection and transport faults as not', async () => {
    expect(new RejectedError('x').retryable).toBe(true);
    expect(new TransportError('x').retryable).toBe(false);
    expect(new AmbiguousSendError('x').retryable).toBe(false);
  });
});

describe('F3: waitForLanding tolerates transient poll failures', () => {
  it('keeps polling through an RPC error and still reports Landed', async () => {
    const spy = mockFetchSequence([
      { throw: new Error('socket hang up') },
      { body: { result: { value: [{ bundle_id: 'b', status: 'Landed' }] } } },
    ]);

    const client = new JitoClient('https://example.invalid');
    const result = await client.waitForLanding('b', 5_000, 1);

    expect(result.status).toBe('Landed');
    expect(result.pollErrors).toBeGreaterThanOrEqual(1);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports Timeout (which means UNKNOWN, not "did not land")', async () => {
    mockFetchSequence([
      { body: { result: { value: [{ bundle_id: 'b', status: 'Pending' }] } } },
    ]);

    const client = new JitoClient('https://example.invalid');
    const result = await client.waitForLanding('b', 20, 1);
    expect(result.status).toBe('Timeout');
  });
});

describe('Jito configuration wiring', () => {
  it('uses the configured landing poll interval by default', async () => {
    vi.useFakeTimers();
    const client = new JitoClient('https://example.invalid', { pollMs: 17 });
    const status = vi
      .spyOn(client, 'bundleStatus')
      .mockResolvedValueOnce('Pending')
      .mockResolvedValueOnce('Landed');
    vi.spyOn(client, 'bundleDetails').mockResolvedValue({
      bundle_id: 'b',
      status: 'Landed',
      transactions: ['sig'],
    });

    const resultPromise = client.waitForLanding('b', 100);
    await vi.advanceTimersByTimeAsync(16);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toMatchObject({ status: 'Landed' });
    expect(status).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('honors the configured tip-account TTL', async () => {
    vi.useFakeTimers();
    const client = new JitoClient('https://example.invalid', {
      tipAccountsTtlMs: 25,
    });
    const rpc = vi
      .spyOn(
        client as unknown as { rpc: (method: string, params: unknown[]) => Promise<unknown> },
        'rpc',
      )
      .mockResolvedValue(['11111111111111111111111111111111']);

    await client.tipAccounts();
    await client.tipAccounts();
    expect(rpc).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24);
    await client.tipAccounts();
    expect(rpc).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await client.tipAccounts();
    expect(rpc).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('preserves the existing 300ms landing-poll and 60s tip-account defaults', async () => {
    vi.useFakeTimers();
    const client = new JitoClient('https://example.invalid');
    const status = vi
      .spyOn(client, 'bundleStatus')
      .mockResolvedValueOnce('Pending')
      .mockResolvedValueOnce('Landed');
    vi.spyOn(client, 'bundleDetails').mockResolvedValue({
      bundle_id: 'b',
      status: 'Landed',
      transactions: ['sig'],
    });

    const resultPromise = client.waitForLanding('b', 1_000);
    await vi.advanceTimersByTimeAsync(299);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toMatchObject({ status: 'Landed' });

    const rpc = vi
      .spyOn(
        client as unknown as { rpc: (method: string, params: unknown[]) => Promise<unknown> },
        'rpc',
      )
      .mockResolvedValue(['11111111111111111111111111111111']);
    await client.tipAccounts();
    await vi.advanceTimersByTimeAsync(59_999);
    await client.tipAccounts();
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await client.tipAccounts();
    expect(rpc).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('F5: SPL Token program ids are correct', () => {
  it('uses the canonical SPL Token program id', () => {
    expect(TOKEN_PROGRAM.toBase58()).toBe(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
  });

  it('uses the canonical Token-2022 program id', () => {
    expect(TOKEN_2022_PROGRAM.toBase58()).toBe(
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    );
  });

  it('queries BOTH token programs for balances', () => {
    expect(TOKEN_PROGRAMS).toHaveLength(2);
    expect(TOKEN_PROGRAMS.every((p) => p instanceof PublicKey)).toBe(true);
  });

  it('program ids agree across packages', async () => {
    const { KNOWN_PROGRAM_IDS } = await import('@mayhem/config');
    expect(KNOWN_PROGRAM_IDS.SPL_TOKEN).toBe(TOKEN_PROGRAM.toBase58());
    expect(KNOWN_PROGRAM_IDS.TOKEN_2022).toBe(TOKEN_2022_PROGRAM.toBase58());
    // Raydium AMM v4 — previously two different values existed.
    expect(KNOWN_PROGRAM_IDS.RAYDIUM_V4).toBe(
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    );
  });
});
