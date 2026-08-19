/** Mayhem dashboard domain types — mirror the backend contract. */
export type OrderSide = "BUY" | "SELL";

export type ActivityType =
  | "INFO" | "SUCCESS" | "WARNING" | "ERROR" | "TRADE" | "SYSTEM";

export interface ActivityEntry {
  id: string;
  timestamp: number;
  message: string;
  type: ActivityType;
}

/** Where a token sits in the launch lifecycle. UNKNOWN means the backend
 *  didn't send a recognized value (e.g. an older cached record). */
export type TokenStage = "DETECTED" | "LP_ADDED" | "BONDING_CURVE" | "GRADUATED" | "UNKNOWN";

export interface MarketToken {
  id: string;
  name: string;
  symbol: string;
  address: string;
  price: number;
  marketCap: number;
  liquidity: number;
  volume24h: number;
  change1m: number;
  change5m: number;
  change15m: number;
  holders: number;
  ageSec: number;
  riskScore: number;
  buyPressure: number;
  sellPressure: number;
  stage: TokenStage;
  graduatedAt: string | null;
}

const KNOWN_STAGES: TokenStage[] = ["DETECTED", "LP_ADDED", "BONDING_CURVE", "GRADUATED", "UNKNOWN"];

/**
 * The backend's /api/tokens payload is the raw internal record shape
 * (see apps/api/src/routes.ts postInternalTokens) — keyed by `tokenMint`,
 * with no `id`/`address`/`ageSec`/`change1m`/`change5m`/`change15m` fields.
 * Those fields simply aren't computed anywhere in the pipeline yet, so
 * they must be derived or defaulted here rather than fabricated upstream.
 *
 * This is the single source of truth for turning that raw shape into the
 * dashboard's `MarketToken` type — every fetch loop should route through
 * this instead of casting the raw response directly (that bug caused
 * every row to share the same `undefined` id/key and left age/change
 * columns permanently blank).
 */
export function normalizeMarketToken(raw: unknown): MarketToken {
  const r = (raw ?? {}) as Record<string, unknown>;

  const mint = typeof r.tokenMint === "string" ? r.tokenMint : "";
  const discoveredAt = typeof r.discoveredAt === "string" ? Date.parse(r.discoveredAt) : NaN;
  const ageSec = Number.isFinite(discoveredAt)
    ? Math.max(0, Math.round((Date.now() - discoveredAt) / 1000))
    : 0;

  const stageRaw = typeof r.stage === "string" ? r.stage.toUpperCase() : "UNKNOWN";
  const stage = (KNOWN_STAGES as string[]).includes(stageRaw) ? (stageRaw as TokenStage) : "UNKNOWN";

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  return {
    id: mint,
    address: mint,
    symbol: typeof r.symbol === "string" && r.symbol ? r.symbol : "UNKNOWN",
    name: typeof r.name === "string" && r.name ? r.name : "Unknown token",
    price: num(r.price),
    marketCap: num(r.marketCap),
    liquidity: num(r.liquidity),
    volume24h: num(r.volume24h),
    // Not computed anywhere in the pipeline yet (no time-series price
    // history is kept) — defaulted to 0 rather than fabricated.
    change1m: 0,
    change5m: 0,
    change15m: 0,
    holders: num(r.holders),
    ageSec,
    riskScore: num(r.riskScore),
    buyPressure: 0,
    sellPressure: 0,
    stage,
    graduatedAt: typeof r.graduatedAt === "string" ? r.graduatedAt : null,
  };
}

export interface Position {
  id: string;
  tokenMint: string;
  symbol?: string;
  side?: string;
  entryPrice: number;
  amount?: number;
  amountSol?: number;
  status: string;
  openedAt?: string;
  createdAt?: string;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  value?: number;
}

export interface Order {
  id: string;
  side: string;
  symbol: string;
  tokenMint: string;
  amountSol: number;
  tokenAmount: number;
  price: number;
  signature?: string;
  mode?: string;
  status?: string;
  createdAt?: string;
  time?: string;
}

export interface OrderResponse {
  ok?: boolean;
  mode?: string;
  order?: Order;
  position?: Position;
  error?: string;
  message?: string;
  signature?: string;
}

/** Raw /api/status payload — every field optional; we read exactly
 *  what the backend actually returns and normalize below. */
export interface RawApiStatus {
  status?: unknown;
  mode?: unknown;
  dryRun?: unknown;
  paper?: unknown;
  tradingEnabled?: unknown;
  canTrade?: unknown;
  botRunning?: unknown;
  running?: unknown;
  paused?: unknown;
  emergencyStop?: unknown;
  emergencyStopped?: unknown;
  killSwitch?: unknown;
  startedAt?: unknown;
  serverTime?: unknown;
  uptimeSec?: unknown;
  openPositions?: unknown;
  totalTrades?: unknown;
  [key: string]: unknown;
}

export type RuntimeMode = "DRY_RUN" | "LIVE" | "UNKNOWN";

export interface NormalizedStatus {
  mode: RuntimeMode;
  dryRun: boolean;
  /** Raw backend flag — trust with caution, may be true during dry-run
   *  if the backend's own dryRun AND-gate is misconfigured. Prefer
   *  `tradingLive` for anything shown to the user as a safety signal. */
  tradingEnabled: boolean;
  /** Derived, client-side-enforced signal: real capital is actually at
   *  risk only when tradingEnabled AND NOT dryRun. This guards against
   *  the backend reporting tradingEnabled=true while dryRun=true. */
  tradingLive: boolean;
  botRunning: boolean;
  emergencyStop: boolean;
  startedAt: string | null;
  serverTime: string | null;
  uptimeSec: number | null;
  openPositions: number | null;
  totalTrades: number | null;
}

export function normalizeStatus(raw: unknown): NormalizedStatus {
  const value: RawApiStatus =
    typeof raw === "object" && raw !== null ? (raw as RawApiStatus) : {};

  const bool = (candidate: unknown): boolean | undefined =>
    typeof candidate === "boolean" ? candidate : undefined;
  const num = (candidate: unknown): number | null =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  const str = (candidate: unknown): string | null =>
    typeof candidate === "string" && candidate.trim() ? candidate : null;

  const modeRaw = str(value.mode) ?? str(value.status) ?? null;
  const modeText = modeRaw ? modeRaw.toUpperCase() : "";

  const dryRun =
    bool(value.dryRun) ??
    bool(value.paper) ??
    (modeText.includes("DRY") ||
      modeText.includes("PAPER") ||
      modeText.includes("SIM"));

  const tradingEnabled =
    bool(value.tradingEnabled) ?? bool(value.canTrade) ?? !dryRun;

  // Never let a raw tradingEnabled=true look "live" while dryRun=true —
  // this is a deliberate client-side re-derivation, independent of
  // whatever the backend reports, so a backend gating bug can't produce
  // a false "trading is live" signal in the UI.
  const tradingLive = tradingEnabled && !dryRun;

  const botRunning =
    bool(value.botRunning) ?? bool(value.running) ?? !bool(value.paused);

  const emergencyStop =
    bool(value.emergencyStop) ??
    bool(value.emergencyStopped) ??
    bool(value.killSwitch) ??
    false;

  const mode: RuntimeMode = dryRun
    ? "DRY_RUN"
    : modeText.includes("LIVE")
      ? "LIVE"
      : "UNKNOWN";

  return {
    mode,
    dryRun,
    tradingEnabled,
    tradingLive,
    botRunning,
    emergencyStop,
    startedAt: str(value.startedAt),
    serverTime: str(value.serverTime),
    uptimeSec: num(value.uptimeSec),
    openPositions: num(value.openPositions),
    totalTrades: num(value.totalTrades),
  };
}