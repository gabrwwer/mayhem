
export interface TradeRecord {
  netPnl: number;
}

export interface PnlSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
}

export function trackPnL(trades: TradeRecord[]): PnlSummary {
  const winning = trades.filter((t) => t.netPnl > 0);
  const losing = trades.filter((t) => t.netPnl < 0);
  const grossProfit = winning.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = Math.abs(losing.reduce((sum, t) => sum + t.netPnl, 0));
  const total = trades.length;
  const netPnl = grossProfit - grossLoss;

  return {
    totalTrades: total,
    winningTrades: winning.length,
    losingTrades: losing.length,
    grossProfit,
    grossLoss,
    netPnl,
    winRate: total > 0 ? (winning.length / total) * 100 : 0,
    averageWin: winning.length > 0 ? grossProfit / winning.length : 0,
    averageLoss: losing.length > 0 ? grossLoss / losing.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
  };
}