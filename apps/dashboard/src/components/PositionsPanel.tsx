import type { Position } from "../types/trading";
import { formatPrice, shortAddress } from "../lib/format";

export interface PositionsPanelProps {
  positions: Position[];
  loading: boolean;
  error: string | null;
}

export default function PositionsPanel({
  positions,
  loading,
  error,
}: PositionsPanelProps) {
  const hasCurrent = positions.some((p) => typeof p.currentPrice === "number");
  const hasValue = positions.some((p) => typeof p.value === "number");
  const hasPnl = positions.some(
    (p) => typeof p.pnl === "number" || typeof p.pnlPercent === "number",
  );
  const hasOpened = positions.some((p) => p.openedAt || p.createdAt);

  const columns = [
    "minmax(110px,1.4fr)", // TOKEN
    "minmax(52px,0.6fr)", // SIDE
    "minmax(80px,1fr)", // ENTRY
    ...(hasCurrent ? ["minmax(80px,1fr)"] : []), // CURRENT
    "minmax(90px,1fr)", // AMOUNT
    ...(hasValue ? ["minmax(90px,1fr)"] : []), // VALUE
    ...(hasPnl ? ["minmax(90px,1fr)"] : []), // P/L
    ...(hasOpened ? ["minmax(90px,1fr)"] : []), // OPENED
    "minmax(70px,0.8fr)", // STATUS
  ].join(" ");

  return (
    <section className="panel positions-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">PORTFOLIO</span>
          <h2>POSITIONS</h2>
        </div>
        <span className="live-indicator">{positions.length} OPEN</span>
      </div>

      {loading && positions.length === 0 ? (
        <div className="position-empty">
          <strong>LOADING POSITIONS...</strong>
        </div>
      ) : positions.length === 0 ? (
        <div className="position-empty">
          <strong>NO OPEN POSITIONS</strong>
          <span>No positions reported by the backend.</span>
        </div>
      ) : (
        <div className="position-table">
          <div className="position-head" style={{ gridTemplateColumns: columns }}>
            <span>TOKEN</span>
            <span>SIDE</span>
            <span>ENTRY</span>
            {hasCurrent && <span>CURRENT</span>}
            <span>AMOUNT</span>
            {hasValue && <span>VALUE</span>}
            {hasPnl && <span>P/L</span>}
            {hasOpened && <span>OPENED</span>}
            <span>STATUS</span>
          </div>

          {positions.map((position) => (
            <div
              className="position-row"
              key={position.id}
              style={{ gridTemplateColumns: columns }}
            >
              <span className="mono" title={position.tokenMint}>
                {position.symbol ?? shortAddress(position.tokenMint)}
              </span>
              <span className="mono">
                {position.side?.toUpperCase() ?? "—"}
              </span>
              <span className="mono">{formatPrice(Number(position.entryPrice))}</span>
              {hasCurrent && (
                <span className="mono">
                  {typeof position.currentPrice === "number"
                    ? formatPrice(position.currentPrice)
                    : "—"}
                </span>
              )}
              <span className="mono">
                {typeof position.amountSol === "number"
                  ? `${position.amountSol.toFixed(3)} SOL`
                  : typeof position.amount === "number"
                    ? position.amount.toLocaleString()
                    : "—"}
              </span>
              {hasValue && (
                <span className="mono">
                  {typeof position.value === "number"
                    ? `$${position.value.toFixed(2)}`
                    : "—"}
                </span>
              )}
              {hasPnl && (
                <span
                  className={`mono ${
                    typeof position.pnl === "number"
                      ? position.pnl >= 0
                        ? "positive"
                        : "negative"
                      : ""
                  }`}
                >
                  {typeof position.pnl === "number"
                    ? `${position.pnl >= 0 ? "+" : ""}$${position.pnl.toFixed(2)}`
                    : typeof position.pnlPercent === "number"
                      ? `${position.pnlPercent >= 0 ? "+" : ""}${position.pnlPercent.toFixed(2)}%`
                      : "—"}
                </span>
              )}
              {hasOpened && (
                <span className="mono">
                  {position.openedAt ?? position.createdAt ?? "—"}
                </span>
              )}
              <span className="mono">{position.status.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="order-error">POSITIONS ERROR — {error}</div>}
    </section>
  );
}