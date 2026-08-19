/**
 * Canonical discovered-token type.
 *
 * Replaces the three overlapping token shapes that previously existed
 * (`ApiToken`, and two different `MarketToken` definitions), two of which were
 * backed by hardcoded fake data.
 *
 * Every metric is `number | null`. The backend's `/api/tokens` payload is
 * assembled by `postInternalTokens` in apps/api/src/routes.ts, which
 * explicitly leaves enrichment fields `null` until the bot computes them.
 * Coercing those nulls to 0 — as the previous normalizer did — turns
 * "we don't know the liquidity" into "the liquidity is zero", which is a
 * materially different and potentially trade-influencing claim.
 */

export type TokenStage =
  | "DETECTED"
  | "LP_ADDED"
  | "BONDING_CURVE"
  | "GRADUATED"
  | "UNKNOWN";

export interface DiscoveredToken {
  /** Mint address. Also the stable React key. */
  mint: string;
  symbol: string;
  name: string | null;
  stage: TokenStage;
  source: string | null;

  /** SOL per token. */
  price: number | null;
  /** Market cap in SOL — same unit as `price`. */
  marketCap: number | null;
  /** Market cap in USD. Different unit to `marketCap`; never mix the two. */
  usdMarketCap: number | null;
  /**
   * Supply in WHOLE tokens, already scaled by mint decimals by the bot.
   *
   * Never the raw base-unit figure. `price` is derived as marketCap divided by
   * this, so the two must stay in matching units — mixing them understates the
   * price by 10^decimals.
   */
  totalSupply: number | null;
  /** SOL in the pool / bonding curve. */
  liquidity: number | null;
  volume24h: number | null;
  holders: number | null;
  topHolderPercent: number | null;

  /**
   * Heuristic safety score, 0-100, where **higher = safer**.
   *
   * Read the producer before changing any label that depends on this:
   * apps/bot/src/enrichment.ts `heuristicRiskScore` starts at 50, adds up to
   * 25 for deep liquidity and subtracts up to 30 for holder concentration. It
   * is explicitly "not a real risk model".
   *
   * This is NOT the MAYHEM Score from the spec, which does not exist anywhere
   * in the backend — see docs/MAYHEM_UI_ASSESSMENT.md §4.
   */
  riskScore: number | null;

  poolAddress: string | null;
  initialLiquidity: number | null;
  enrichmentNote: string | null;

  discoveredAt: string | null;
  updatedAt: string | null;
  graduatedAt: string | null;

  /** Seconds since discovery, derived client-side. Null if no timestamp. */
  ageSec: number | null;
}

const STAGES: TokenStage[] = [
  "DETECTED",
  "LP_ADDED",
  "BONDING_CURVE",
  "GRADUATED",
  "UNKNOWN",
];

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeDiscoveredToken(raw: unknown): DiscoveredToken {
  const r = (raw ?? {}) as Record<string, unknown>;

  const mint = str(r.tokenMint) ?? str(r.mint) ?? str(r.address) ?? "";
  const discoveredAt = str(r.discoveredAt);
  const discoveredMs = discoveredAt ? Date.parse(discoveredAt) : NaN;

  const stageRaw = typeof r.stage === "string" ? r.stage.toUpperCase() : "";
  const stage = (STAGES as string[]).includes(stageRaw)
    ? (stageRaw as TokenStage)
    : "UNKNOWN";

  return {
    mint,
    symbol: str(r.symbol) ?? "UNKNOWN",
    name: str(r.name),
    stage,
    source: str(r.source),

    price: num(r.price),
    marketCap: num(r.marketCap),
    usdMarketCap: num(r.usdMarketCap),
    totalSupply: num(r.totalSupply),
    liquidity: num(r.liquidity),
    volume24h: num(r.volume24h),
    holders: num(r.holders),
    topHolderPercent: num(r.topHolderPercent),
    riskScore: num(r.riskScore),

    poolAddress: str(r.poolAddress),
    initialLiquidity: num(r.initialLiquidity),
    enrichmentNote: str(r.enrichmentNote),

    discoveredAt,
    updatedAt: str(r.updatedAt),
    graduatedAt: str(r.graduatedAt),

    ageSec: Number.isFinite(discoveredMs)
      ? Math.max(0, Math.round((Date.now() - discoveredMs) / 1000))
      : null,
  };
}

export function normalizeDiscoveredTokens(raw: unknown): DiscoveredToken[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeDiscoveredToken).filter((t) => t.mint !== "");
}

export const STAGE_TONE: Record<TokenStage, "ok" | "warn" | "info" | "muted"> = {
  GRADUATED: "ok",
  BONDING_CURVE: "warn",
  LP_ADDED: "info",
  DETECTED: "info",
  UNKNOWN: "muted",
};
