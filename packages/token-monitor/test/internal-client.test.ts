import { describe, it, expect, vi } from 'vitest';
import { signInternalPayload, postInternalFlow } from '../src/internal-client';
import { createInternalAuth } from '../../../apps/api/src/middleware/internal-auth';

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('token-monitor internal client', () => {
  it('signInternalPayload matches API verifier', () => {
    const secret = 'shared-secret';
    const ts = Date.now();
    const body = JSON.stringify({ a: 1 });
    const sig = signInternalPayload(secret, ts, body);

    const mw = createInternalAuth({ secret, now: () => ts });
    const next = vi.fn();
    const req: any = { headers: { 'x-mayhem-timestamp': String(ts), 'x-mayhem-signature': sig }, rawBody: body };
    const res = mockRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('postInternalFlow handles fetch rejection without throwing', async () => {
    const origUrl = process.env['API_URL'];
    const origSecret = process.env['INTERNAL_API_SECRET'];
    process.env['API_URL'] = 'http://localhost:9999';
    process.env['INTERNAL_API_SECRET'] = 's';

    const fakeFetch = vi.fn(() => Promise.reject(new Error('network fail')));
    vi.stubGlobal('fetch', fakeFetch as any);

    await expect(postInternalFlow({ type: 'transaction', mint: 'M2' })).resolves.toBeUndefined();

    if (origUrl === undefined) delete process.env['API_URL']; else process.env['API_URL'] = origUrl;
    if (origSecret === undefined) delete process.env['INTERNAL_API_SECRET']; else process.env['INTERNAL_API_SECRET'] = origSecret;
    vi.unstubAllGlobals();
  });
});
