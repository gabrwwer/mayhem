import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketToken } from "../types/trading";
import { formatCompact, formatPrice, formatSignedPercent } from "../lib/format";

const VIEW_W = 1000;
const VIEW_H = 300;
const PAD = 10;
const MAX_POINTS = 150;

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

export interface MarketChartProps {
  token: MarketToken;
}

export default function MarketChart({ token }: MarketChartProps) {
  const [series, setSeries] = useState<number[]>([token.price]);
  const lastPriceRef = useRef(token.price);

  // Reset the series when the selected token changes.
  useEffect(() => {
    setSeries([token.price]);
    lastPriceRef.current = token.price;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.id]);

  // Append real price ticks as they arrive from the feed.
  useEffect(() => {
    if (token.price === lastPriceRef.current) return;
    lastPriceRef.current = token.price;
    setSeries((current) =>
      current.length >= MAX_POINTS
        ? [...current.slice(1), token.price]
        : [...current, token.price],
    );
  }, [token.price]);

  const path = useMemo(() => {
    if (series.length < 2) return "";
    const min = Math.min(...series);
    const max = Math.max(...series);
    const range = max - min || 1;
    const points = series.map((price, index) => {
      const x = (index / (series.length - 1)) * VIEW_W;
      const y = VIEW_H - PAD - ((price - min) / range) * (VIEW_H - PAD * 2);
      return [x, y] as const;
    });
    return points
      .map(([x, y], index) =>
        `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`,
      )
      .join(" ");
  }, [series]);

  const areaPath = path
    ? `${path} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z`
    : "";

  const trend =
    series.length >= 2
      ? series[series.length - 1] >= series[0]
        ? "up"
        : "down"
      : "flat";

  return (
    <section className="panel chart-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">MARKET</span>
          <h2>
            {token.symbol} / {token.name}
          </h2>
        </div>
        <span className="sim-badge">SIMULATED FEED</span>
      </div>

      <div className="price-header">
        <strong>{formatPrice(token.price)}</strong>
        <span className={token.change5m >= 0 ? "positive" : "negative"}>
          {formatSignedPercent(token.change5m)}
        </span>
      </div>

      <div className="token-meta">
        <span>
          MCAP <strong>{formatCompact(token.marketCap)}</strong>
        </span>
        <span>
          LIQ <strong>{formatCompact(token.liquidity)}</strong>
        </span>
        <span>
          VOL <strong>{formatCompact(token.volume24h)}</strong>
        </span>
        <span>
          HOLDERS <strong>{token.holders != null ? token.holders.toLocaleString() : "—"}</strong>
        </span>
        <span>
          RISK <strong>{token.riskScore}/100</strong>
        </span>
      </div>

      <div className="chart-wrap" data-trend={trend}>
        <svg
          className="chart-svg"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${token.symbol} simulated price chart`}
        >
          {areaPath && <path d={areaPath} className="chart-area" />}
          {path && <path d={path} className="chart-line" />}
        </svg>
        <span className="chart-sample-note">
          SAMPLED FROM LOCAL FEED — NOT LIVE MARKET DATA
        </span>
      </div>

      <div className="timeframes">
        {TIMEFRAMES.map((timeframe) => (
          <button
            key={timeframe}
            type="button"
            disabled
            title="HISTORICAL DATA NOT AVAILABLE — requires a backend price-history endpoint"
          >
            {timeframe}
          </button>
        ))}
      </div>

      <div className="pressure-labels">
        <span>
          BUY PRESSURE <strong>{token.buyPressure}%</strong>
        </span>
        <span>
          SELL PRESSURE <strong>{token.sellPressure}%</strong>
        </span>
      </div>
    </section>
  );
}