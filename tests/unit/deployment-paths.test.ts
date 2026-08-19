import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `resolve-base-url.ts` lives in the dashboard, which is an ESM package,
 * while this test compiles as CommonJS (the repo root has no
 * `"type": "module"`). Under Node16 resolution a static import here would
 * produce a `require()` of an ES module — TS1479.
 *
 * Two details this needs to get right:
 *   - the specifier carries a `.js` extension, as Node16 resolution
 *     requires for a relative ESM import (TS2835);
 *   - the type is declared locally rather than via `typeof import(...)`,
 *     because a TYPE import of an ESM module from CJS additionally demands
 *     a `resolution-mode` attribute (TS1542). Restating the signature is
 *     less machinery than that, and it double-checks the contract: if the
 *     real function's shape drifts, the assignment below stops compiling.
 */
type LocationLike = {
  hostname?: string;
  port?: string;
  protocol?: string;
  origin?: string;
};

type ResolveApiBaseUrl = (
  configured?: string | undefined,
  location?: LocationLike,
) => string;

let resolveApiBaseUrl: ResolveApiBaseUrl;

beforeAll(async () => {
  const mod = await import('../../apps/dashboard/src/api/resolve-base-url.js');
  resolveApiBaseUrl = mod.resolveApiBaseUrl;
});

describe('resolveApiBaseUrl', () => {
  it('uses the configured production base when provided', () => {
    expect(resolveApiBaseUrl('https://api.example.com')).toBe('https://api.example.com/api');
    expect(resolveApiBaseUrl('https://api.example.com/api')).toBe('https://api.example.com/api');
  });

  it('falls back to the local API port during dashboard development', () => {
    expect(resolveApiBaseUrl(undefined, { hostname: 'localhost', port: '3000' })).toBe('http://localhost:3001/api');
  });

  it('uses the current origin in deployed environments', () => {
    expect(resolveApiBaseUrl(undefined, { origin: 'https://dashboard.example.com' })).toBe('https://dashboard.example.com/api');
  });
});
