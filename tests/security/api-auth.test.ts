import { describe, it, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../../apps/api/src/middleware/auth';
import { createRateLimit } from '../../apps/api/src/middleware/rate-limit';
import {
  createInternalAuth,
  signInternalPayload,
} from '../../apps/api/src/middleware/internal-auth';

/**
 * F8 / F9 / F10 / F21 / F22 regressions.
 *
 * The failure these lock down: every one of these routes was reachable
 * without a credential, on an interface bound to 0.0.0.0.
 */

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
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
  };
  return res;
}

function mockReq(headers: Record<string, string> = {}) {
  return {
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

describe('F9: auth cannot be disabled', () => {
  it('refuses every request when no tokens are configured — even outside production', () => {
    const mw = createAuthMiddleware({ tokens: [] });
    const res = mockRes();
    const next = vi.fn();

    mw(mockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });
});

describe('F8/F21: bearer token enforcement', () => {
  const mw = createAuthMiddleware({ tokens: ['correct-token'] });

  it('rejects a missing Authorization header', () => {
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong token', () => {
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ authorization: 'Bearer nope' }), res, next);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a correct-prefix token (no prefix matching)', () => {
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ authorization: 'Bearer correct' }), res, next);
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct token', () => {
    const res = mockRes();
    const next = vi.fn();
    mw(mockReq({ authorization: 'Bearer correct-token' }), res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('F22: rate limiting is enforced', () => {
  it('returns 429 past the configured maximum', () => {
    let clock = 0;
    const mw = createRateLimit({ windowMs: 1_000, max: 2, now: () => clock });
    const req = { ip: '1.2.3.4', socket: {} } as any;

    const first = mockRes();
    const second = mockRes();
    const third = mockRes();
    const next = vi.fn();

    mw(req, first, next);
    mw(req, second, next);
    mw(req, third, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(third.statusCode).toBe(429);
    expect(third.headers['Retry-After']).toBeDefined();
  });

  it('resets after the window elapses', () => {
    let clock = 0;
    const mw = createRateLimit({ windowMs: 1_000, max: 1, now: () => clock });
    const req = { ip: '1.2.3.4', socket: {} } as any;
    const next = vi.fn();

    mw(req, mockRes(), next);
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);

    clock += 2_000;
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('F8: /internal routes require a valid signature', () => {
  const secret = 'shared-secret';
  const mw = createInternalAuth({ secret });

  it('rejects an unsigned request', () => {
    const res = mockRes();
    const next = vi.fn();
    mw({ headers: {}, rawBody: '{}' } as any, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a request signed with the wrong secret', () => {
    const body = '{"tokenMint":"evil"}';
    const ts = Date.now();
    const res = mockRes();
    const next = vi.fn();

    mw(
      {
        headers: {
          'x-mayhem-timestamp': String(ts),
          'x-mayhem-signature': signInternalPayload('wrong-secret', ts, body),
        },
        rawBody: body,
      } as any,
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
  });

  it('rejects a replayed request outside the skew window', () => {
    const body = '{"a":1}';
    const ts = Date.now() - 120_000;
    const res = mockRes();
    const next = vi.fn();

    mw(
      {
        headers: {
          'x-mayhem-timestamp': String(ts),
          'x-mayhem-signature': signInternalPayload(secret, ts, body),
        },
        rawBody: body,
      } as any,
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered body with an otherwise valid signature', () => {
    const signedBody = '{"a":1}';
    const ts = Date.now();
    const res = mockRes();
    const next = vi.fn();

    mw(
      {
        headers: {
          'x-mayhem-timestamp': String(ts),
          'x-mayhem-signature': signInternalPayload(secret, ts, signedBody),
        },
        rawBody: '{"a":2}',
      } as any,
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
  });

  it('accepts a correctly signed, fresh request', () => {
    const body = '{"tokenMint":"MintA"}';
    const ts = Date.now();
    const res = mockRes();
    const next = vi.fn();

    mw(
      {
        headers: {
          'x-mayhem-timestamp': String(ts),
          'x-mayhem-signature': signInternalPayload(secret, ts, body),
        },
        rawBody: body,
      } as any,
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  it('refuses to construct without a secret', () => {
    expect(() => createInternalAuth({ secret: '' })).toThrow(/INTERNAL_API_SECRET/);
  });
});

describe('F10: the parallel unauthenticated app is gone', () => {
  it('createApp throws instead of building an unauthenticated server', async () => {
    // Node16 resolution requires the extension on a relative ESM import.
    const { createApp } = await import('../../apps/api/src/app.js');
    expect(() => createApp()).toThrow(/unauthenticated/i);
  });
});
