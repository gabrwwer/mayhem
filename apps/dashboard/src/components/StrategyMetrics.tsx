import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { ApiTrade, ApiTelemetry } from "../types/api";

function parseWinRate(text?: string | null): number | null {
  if (!text) return null;
  const m = String(text).match(/([0-9.]+)\s*%/);
  if (m) return parseFloat(m[1]) / 100;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export default function StrategyMetrics() {
  const [trades, setTrades] = useState<ApiTrade[] | null>(null);
  const [telemetry, setTelemetry] = useState<ApiTelemetry | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [t, tel] = await Promise.all([api.getTrades(), api.getTelemetry()]);
        if (cancelled) return;
        setTrades((t as ApiTrade[]) ?? []);
        setTelemetry(tel as ApiTelemetry);
      } catch (err) {
        // ignore
      }
    }
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const metrics = useMemo(() => {
    if (!trades || trades.length === 0) return null;

    const times = trades
      .map((t) => (t.createdAt ? new Date(t.createdAt).getTime() : NaN))
      .filter((x) => Number.isFinite(x)) as number[];

    const first = Math.min(...times);
    const last = Math.max(...times);
    const days = Math.max(1, (last - first) / (1000 * 60 * 60 * 24));
    const tradesPerDay = trades.length / days;

    const totalPnl = telemetry?.totalPnl ?? null;
    const avgPnlPerTrade = totalPnl && trades.length > 0 ? totalPnl / trades.length : null;

    const winRate = parseWinRate(telemetry?.winRate) ?? null;

    // Projected annualized return using avgPnlPerTrade and trades/day
    let projectedAnnual = null as number | null;
    if (avgPnlPerTrade !== null && tradesPerDay > 0) {
      const tradesPerYear = tradesPerDay * 252; // trading days approximation
      projectedAnnual = Math.pow(1 + avgPnlPerTrade, tradesPerYear) - 1;
    }

    return {
      count: trades.length,
      tradesPerDay,
      avgPnlPerTrade,
      winRate,
      projectedAnnual,
    };
  }, [trades, telemetry]);

  return (
    <div className="panel" style={{ minWidth: 340 }}>
      <div className="panel-header">
        <div>
          <div className="panel-kicker">METRICS</div>
          <h2>Strategy</h2>
        </div>
      </div>

      {!metrics ? (
        <div>Loading metrics...</div>
      ) : (
        <div style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Trades:</strong> {metrics.count}
          </div>
          <div>Trades / day: {metrics.tradesPerDay.toFixed(2)}</div>
          <div>Win rate: {metrics.winRate !== null ? `${(metrics.winRate * 100).toFixed(1)}%` : "—"}</div>
          <div>
            Avg PnL / trade: {metrics.avgPnlPerTrade !== null ? `${metrics.avgPnlPerTrade.toFixed(4)}` : "—"}
          </div>
          <div>
            Projected annual: {metrics.projectedAnnual !== null ? `${(metrics.projectedAnnual * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
      )}
    </div>
  );
}
