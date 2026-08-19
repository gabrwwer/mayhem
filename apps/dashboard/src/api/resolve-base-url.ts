/**
 * API base URL resolution — deliberately free of browser globals.
 *
 * This lives apart from `client.ts` because `tests/unit/deployment-paths.test.ts`
 * exercises it from the Node test program, which has no DOM lib. Importing
 * `client.ts` there dragged `window`, `import.meta.env` and a bundler-style
 * relative import into a CommonJS/Node16 compilation, producing a cluster of
 * errors that had nothing to do with the logic under test.
 *
 * The rule: anything worth unit-testing should not require a browser to
 * type-check. The caller supplies the location; this module just decides.
 */

/** Minimal shape of `window.location` needed to derive the API base. */
export interface LocationLike {
  hostname?: string;
  port?: string;
  protocol?: string;
  origin?: string;
}

/**
 * Resolve the API base URL, always ending in exactly one `/api`.
 *
 * Behaviour (as specified by deployment-paths.test.ts):
 *   - an explicit base wins, and is idempotent w.r.t. a trailing `/api`,
 *     so `VITE_API_URL=https://host/api` does not yield `/api/api`;
 *   - during dashboard development the Vite dev server runs on a different
 *     port from the API, so same-origin would hit the wrong server;
 *   - when deployed, the dashboard is served from the same origin as the
 *     API, so the origin is the correct base.
 *
 * The previous inline expression in client.ts hardcoded `:3001` in ALL
 * cases, so a deployed dashboard called port 3001 on its own hostname
 * rather than its origin.
 */
export function resolveApiBaseUrl(
  configured?: string | undefined,
  location?: LocationLike,
): string {
  const trimmed = configured?.trim();

  if (trimmed) {
    const base = trimmed.replace(/\/+$/, '');
    return base.endsWith('/api') ? base : `${base}/api`;
  }

  const loc: LocationLike = location ?? {};

  // The Vite dev server runs on its own port; the API does not.
  const isLocalDev =
    (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') &&
    loc.port !== undefined &&
    loc.port !== '3001';

  if (isLocalDev) {
    const protocol = loc.protocol ?? 'http:';
    return `${protocol}//${loc.hostname}:3001/api`;
  }

  if (loc.origin) {
    return `${loc.origin.replace(/\/+$/, '')}/api`;
  }

  return '/api';
}
