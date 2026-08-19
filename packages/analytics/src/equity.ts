
export interface ClosedTrade {
  timestamp: number;
  netPnl: number;
  tokenMint: string;
  reason: string;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
}

/**
 * Build an equity curve from a starting balance and a chronological
 * list of closed trades. The first point is the starting equity.
 */
export function equityCurve(
  initialEquity: number,
  closedTrades: ClosedTrade[],
): EquityPoint[] {
  const sorted = [...closedTrades].sort((a, b) => a.timestamp - b.timestamp);
  const points: EquityPoint[] = [
    { timestamp: sorted[0]?.timestamp ?? Date.now(), equity: initialEquity },
  ];
  let running = initialEquity;
  for (const trade of sorted) {
    running += trade.netPnl;
    points.push({ timestamp: trade.timestamp, equity: running });
  }
  return points;
}

/** Max peak-to-trough drawdown over the curve, as a positive percentage. */
export function maxDrawdownPct(points: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, ((peak - p.equity) / peak) * 100);
    }
  }
  return maxDrawdown;
}