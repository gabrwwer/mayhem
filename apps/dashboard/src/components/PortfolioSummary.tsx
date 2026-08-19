import type { Position } from "../types/trading";

export interface PortfolioSummaryProps {
  positions: Position[];
  openPositions: number | null;
  totalTrades: number | null;
}

function Metric({
  label,
  value,
  tone = "idle",
}: {
  label: string;
  value: string;
  tone?: "ok" | "bad" | "idle";
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong className="metric-value" data-tone={tone}>
        {value}
      </strong>
    </div>
  );
}

export default function PortfolioSummary({
  positions,
  openPositions,
  totalTrades,
}: PortfolioSummaryProps) {
  const allValues =
    positions.length > 0 && positions.every((p) => typeof p.value === "number");
  const portfolioValue = allValues
    ? positions.reduce((sum, p) => sum + (p.value ?? 0), 0)
    : null;

  const hasPnl = positions.some((p) => typeof p.pnl === "number");
  const unrealizedPnl = hasPnl
    ? positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)
    : null;

  const allAmounts =
    positions.length > 0 &&
    positions.every((p) => typeof p.amountSol === "number");
  const exposure = allAmounts
    ? positions.reduce((sum, p) => sum + (p.amountSol ?? 0), 0)
    : null;

  const formatUsd = (value: number | null): string =>
    value === null
      ? "N/A"
      : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <section className="portfolio-summary" aria-label="Portfolio summary">
      <Metric
        label="OPEN POSITIONS"
        value={String(openPositions ?? positions.length)}
      />
      <Metric
        label="TOTAL TRADES"
        value={totalTrades !== null ? String(totalTrades) : "N/A"}
      />
      <Metric label="PORTFOLIO VALUE" value={formatUsd(portfolioValue)} />
      <Metric
        label="UNREALIZED P/L"
        value={formatUsd(unrealizedPnl)}
        tone={
          unrealizedPnl === null
            ? "idle"
            : unrealizedPnl >= 0
              ? "ok"
              : "bad"
        }
      />
      {/* Backend does not report realized P/L — never fabricated */}
      <Metric label="REALIZED P/L" value="N/A" />
      <Metric
        label="EXPOSURE"
        value={exposure === null ? "N/A" : `${exposure.toFixed(3)} SOL`}
      />
    </section>
  );
}