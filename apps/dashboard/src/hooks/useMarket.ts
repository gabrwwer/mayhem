/**
 * REMOVED — do not reintroduce.
 *
 * This module exported `useMarket()`, which returned five hardcoded tokens
 * (MAYHEM, ANARCHY, QUANT, VOID, ROCKET) with invented prices, liquidity,
 * holder counts and risk scores, and fed them to panels that were visually
 * indistinguishable from live data.
 *
 * That is the single most dangerous class of bug in a trading interface: an
 * operator cannot tell a fabricated reading from a real one, and the numbers
 * were plausible enough to act on. There was no DEMO banner, no flag, and no
 * marker in the rendered output.
 *
 * Live token data comes from `GET /api/tokens` via `usePolledResource` and
 * `normalizeDiscoveredTokens` (src/types/token.ts), where every metric the
 * backend has not supplied stays `null` and renders as `N/A`.
 *
 * This file is kept as a tombstone rather than silently deleted so the removal
 * is discoverable in the tree, matching the convention in
 * apps/api/src/app.ts.
 */

export function useMarket(): never {
  throw new Error(
    "useMarket has been removed: it returned hardcoded fake market data that " +
      "was rendered as if it were live. Use the /api/tokens feed via " +
      "usePolledResource + normalizeDiscoveredTokens instead.",
  );
}
