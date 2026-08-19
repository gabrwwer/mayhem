export type BotStatus =
  | "STOPPED"
  | "RUNNING"
  | "PAUSED"
  | "EMERGENCY_STOP"
  | "DRY_RUN"
  | "UNKNOWN";

export type ApiStatus = {
  status: BotStatus;
  dryRun: boolean;
  tradingEnabled: boolean;
  emergencyStop: boolean;
  startedAt: string | null;
  openPositions: number;
  totalTrades: number;
};

export type ApiToken = {
  id: string;
  symbol: string;
  name: string;
  address: string;
  price: number | null;
  marketCap: number | null;
  liquidity: number | null;
  volume24h: number | null;
  change1m: number | null;
  change5m: number | null;
  change15m: number | null;
  holders: number | null;
  ageSec: number | null;
  riskScore: number | null;
  buyPressure: number | null;
  sellPressure: number | null;
  stage: string;
  graduatedAt: string | null;
};

export type ApiPosition = {
  id: string;
  tokenMint: string;
  symbol: string;
  side: string;
  status: string;
  entryPrice: number | null;
  currentPrice: number | null;
  amountSol: number | null;
  quantity: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  openedAt: string | null;
  closedAt: string | null;
  exitReason: string | null;
};

export type ApiTrade = {
  id: string;
  side: string;
  tokenMint: string;
  symbol: string;
  amountSol: number | null;
  amountToken: number | null;
  price: number | null;
  status: string;
  createdAt: string | null;
  signature: string | null;
};

export type ApiBalance = {
  sol: number | null;
  tokens: Record<string, number>;
};

export type ApiConfig = {
  dryRun: boolean;
  tradingEnabled: boolean;
  maxPositionSol: number | null;
  maxOpenPositions: number | null;
  takeProfitPercent: number | null;
  stopLossPercent: number | null;
  trailingStopPercent: number | null;
  maxHoldSeconds: number | null;
  slippageBps: number | null;
  minLiquiditySol: number | null;
  maxTopHolderPercent: number | null;
  minHolders: number | null;
  maxDailyLossSol: number | null;
  maxExposureSol: number | null;
  maxDrawdownPct: number | null;
  maxConsecutiveLosses: number | null;
};

/** Response shape from POST /api/config. */
export type ConfigSaveResult = {
  ok: boolean;
  restartRequired: boolean;
  message: string;
  changed: { field: string; envKey: string; from: string | null; to: string }[];
};

export type ApiTelemetry = {
  totalPnl: number | null;
  winRate: string | null;
  winCount: number | null;
  lossCount: number | null;
  successfulTransactions: number | null;
  failedTransactions: number | null;
  avgDiscoveryLatencyMs: number | null;
  avgQuoteLatencyMs: number | null;
  avgTxBuildTimeMs: number | null;
  avgTxConfirmTimeMs: number | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | null {
  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asDateString(value: unknown): string | null {
  if (typeof value === "string") return value;

  if (value instanceof Date) return value.toISOString();

  return null;
}

export function normalizeStatus(value: unknown): ApiStatus {
  const data = asRecord(value);

  return {
    status: asString(data.status, "UNKNOWN") as BotStatus,
    dryRun: asBoolean(data.dryRun),
    tradingEnabled: asBoolean(data.tradingEnabled),
    emergencyStop: asBoolean(data.emergencyStop),
    startedAt: asDateString(data.startedAt),
    openPositions: asNumber(data.openPositions) ?? 0,
    totalTrades: asNumber(data.totalTrades) ?? 0,
  };
}

export function normalizeTokens(value: unknown): ApiToken[] {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const data = asRecord(item);

    return {
      id: asString(data.id, asString(data.tokenMint, `token-${index}`)),
      symbol: asString(data.symbol, "UNKNOWN"),
      name: asString(data.name, asString(data.symbol, "Unknown token")),
      address: asString(data.address, asString(data.tokenMint)),
      price: asNumber(data.price),
      marketCap: asNumber(data.marketCap),
      liquidity: asNumber(data.liquidity),
      volume24h: asNumber(data.volume24h),
      change1m: asNumber(data.change1m),
      change5m: asNumber(data.change5m),
      change15m: asNumber(data.change15m),
      holders: asNumber(data.holders),
      ageSec: asNumber(data.ageSec),
      riskScore: asNumber(data.riskScore),
      buyPressure: asNumber(data.buyPressure),
      sellPressure: asNumber(data.sellPressure),
      stage: asString(data.stage, "UNKNOWN"),
      graduatedAt: asDateString(data.graduatedAt),
    };
  });
}

export function normalizePositions(value: unknown): ApiPosition[] {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const data = asRecord(item);

    return {
      id: asString(data.id, `position-${index}`),
      tokenMint: asString(data.tokenMint),
      symbol: asString(data.symbol, asString(data.tokenMint, "UNKNOWN")),
      side: asString(data.side, "BUY").toUpperCase(),
      status: asString(data.status, "UNKNOWN").toUpperCase(),
      entryPrice: asNumber(data.entryPrice),
      currentPrice: asNumber(data.currentPrice),
      amountSol: asNumber(data.amountSol),
      quantity: asNumber(data.quantity),
      unrealizedPnl: asNumber(data.unrealizedPnl),
      realizedPnl: asNumber(data.realizedPnl),
      openedAt: asDateString(data.openedAt ?? data.entryTime),
      closedAt: asDateString(data.closedAt),
      exitReason: asDateString(data.exitReason),
    };
  });
}

export function normalizeTrades(value: unknown): ApiTrade[] {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const data = asRecord(item);

    return {
      id: asString(data.id, `trade-${index}`),
      side: asString(data.side, "UNKNOWN").toUpperCase(),
      tokenMint: asString(data.tokenMint),
      symbol: asString(data.symbol, asString(data.tokenMint, "UNKNOWN")),
      amountSol: asNumber(data.amountSol),
      amountToken: asNumber(data.amountToken),
      price: asNumber(data.price),
      status: asString(data.status, "UNKNOWN").toUpperCase(),
      createdAt: asDateString(data.createdAt),
      signature: asString(data.signature || data.txSignature) || null,
    };
  });
}

export function normalizeBalance(value: unknown): ApiBalance {
  const data = asRecord(value);
  const rawTokens = asRecord(data.tokens);

  const tokens = Object.fromEntries(
    Object.entries(rawTokens)
      .map(([mint, amount]) => [mint, asNumber(amount)] as const)
      .filter((entry): entry is [string, number] => entry[1] !== null),
  );

  return {
    sol: asNumber(data.sol),
    tokens,
  };
}

export function normalizeConfig(value: unknown): ApiConfig {
  const data = asRecord(value);

  return {
    dryRun: asBoolean(data.dryRun),
    tradingEnabled: asBoolean(data.tradingEnabled),
    maxPositionSol: asNumber(data.maxPositionSol),
    maxOpenPositions: asNumber(data.maxOpenPositions),
    takeProfitPercent: asNumber(data.takeProfitPercent),
    stopLossPercent: asNumber(data.stopLossPercent),
    trailingStopPercent: asNumber(data.trailingStopPercent),
    maxHoldSeconds: asNumber(data.maxHoldSeconds),
    slippageBps: asNumber(data.slippageBps),
    minLiquiditySol: asNumber(data.minLiquiditySol),
    maxTopHolderPercent: asNumber(data.maxTopHolderPercent),
    minHolders: asNumber(data.minHolders),
    maxDailyLossSol: asNumber(data.maxDailyLossSol),
    maxExposureSol: asNumber(data.maxExposureSol),
    maxDrawdownPct: asNumber(data.maxDrawdownPct),
    maxConsecutiveLosses: asNumber(data.maxConsecutiveLosses),
  };
}

export function normalizeTelemetry(value: unknown): ApiTelemetry {
  const data = asRecord(value);

  return {
    totalPnl: asNumber(data.totalPnl),
    winRate: typeof data.winRate === "string" ? data.winRate : null,
    winCount: asNumber(data.winCount),
    lossCount: asNumber(data.lossCount),
    successfulTransactions: asNumber(data.successfulTransactions),
    failedTransactions: asNumber(data.failedTransactions),
    avgDiscoveryLatencyMs: asNumber(data.avgDiscoveryLatencyMs),
    avgQuoteLatencyMs: asNumber(data.avgQuoteLatencyMs),
    avgTxBuildTimeMs: asNumber(data.avgTxBuildTimeMs),
    avgTxConfirmTimeMs: asNumber(data.avgTxConfirmTimeMs),
  };
}