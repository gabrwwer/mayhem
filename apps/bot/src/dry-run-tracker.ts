import { logger } from './logger';

interface ClosedTrade {
  id: string;
  mint: string;
  entryPrice: number;
  exitPrice: number;
  netPnl: number;
  netPnlPercent: number;
  exitReason: string;
  holdTimeSec: number;
  timestamp: Date;
}

export class DryRunTracker {
  private trades: ClosedTrade[] = [];
  private startTime = Date.now();

  recordTrade(position: any): void {
    const trade: ClosedTrade = {
      id: position.id,
      mint: position.tokenMint,
      entryPrice: position.actualEntryPrice ?? position.entryPrice,
      exitPrice: position.currentPrice,
      netPnl: position.netPnl ?? position.realizedPnl ?? 0,
      netPnlPercent: position.netPnlPercent ?? 0,
      exitReason: position.exitReason ?? 'unknown',
      holdTimeSec: position.entryTime
        ? (Date.now() - new Date(position.entryTime).getTime()) / 1000
        : 0,
      timestamp: new Date(),
    };

    this.trades.push(trade);
    this.logStats(trade);
  }

  private logStats(latest: ClosedTrade): void {
    const wins = this.trades.filter((t) => t.netPnl > 0);
    const losses = this.trades.filter((t) => t.netPnl <= 0);
    const totalPnl = this.trades.reduce((s, t) => s + t.netPnl, 0);
    const avgWin = wins.length > 0
      ? wins.reduce((s, t) => s + t.netPnlPercent, 0) / wins.length : 0;
    const avgLoss = losses.length > 0
      ? losses.reduce((s, t) => s + t.netPnlPercent, 0) / losses.length : 0;
    const winRate = this.trades.length > 0
      ? (wins.length / this.trades.length) * 100 : 0;
    const uptimeMin = (Date.now() - this.startTime) / 60000;

    const exitReasons: Record<string, number> = {};
    for (const t of this.trades) {
      exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
    }

    logger.info('DRY_RUN_TRADE_CLOSED', {
      mint: latest.mint,
      pnl: Math.round(latest.netPnl * 1e6) / 1e6,
      pnlPct: Math.round(latest.netPnlPercent * 100) / 100,
      reason: latest.exitReason,
      holdSec: Math.round(latest.holdTimeSec),
    });

    logger.info('DRY_RUN_STATS', {
      totalTrades: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      totalPnl: Math.round(totalPnl * 1e6) / 1e6,
      avgWinPct: Math.round(avgWin * 100) / 100,
      avgLossPct: Math.round(avgLoss * 100) / 100,
      uptimeMin: Math.round(uptimeMin),
      exitReasons,
    });
  }

  getStats() {
    const wins = this.trades.filter((t) => t.netPnl > 0);
    const losses = this.trades.filter((t) => t.netPnl <= 0);
    return {
      total: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this.trades.length > 0 ? (wins.length / this.trades.length) * 100 : 0,
      totalPnl: this.trades.reduce((s, t) => s + t.netPnl, 0),
      trades: this.trades,
    };
  }
}