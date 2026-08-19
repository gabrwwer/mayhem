import type { MarketToken } from "../types/trading";
import { ageLabel, formatCompact, formatPrice } from "../lib/format";

export interface MarketWatchlistProps {
  tokens: MarketToken[];
  selectedId: string;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onSimulate: () => void;
  onClear?: () => void;
  clearing?: boolean;
}

export default function MarketWatchlist({
  tokens,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  onSimulate,
  onClear,
  clearing = false,
}: MarketWatchlistProps) {
  return (
    <aside className="panel market-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">MARKET</span>
          <h2>WATCHLIST</h2>
        </div>
        <span className="sim-badge">SIM</span>
      </div>

      <div className="watchlist-toolbar">
        <div className="search-box">
          <span className="search-icon">⌕</span>
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search token / address..."
            aria-label="Search tokens"
          />
          {search && (
            <button
              type="button"
              className="search-clear"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={onSimulate}
          title="Run market simulation (demo feed — not live data)"
        >
          ↻ SIM
        </button>
        {onClear && (
          <button
            type="button"
            className="clear-tokens-button"
            onClick={onClear}
            disabled={clearing}
            title="Clear all discovered tokens from the bot's memory"
          >
            {clearing ? "CLEARING..." : "CLEAR"}
          </button>
        )}
      </div>

      <div className="token-list">
        {tokens.length === 0 && (
          <div className="token-empty">NO TOKENS MATCH</div>
        )}

        {tokens.map((token) => (
          <button
            type="button"
            key={token.id}
            className={`token-row ${token.id === selectedId ? "selected" : ""}`}
            onClick={() => onSelect(token.id)}
          >
            <div className="token-main">
              <strong>{token.symbol}</strong>
              <span>{token.name}</span>
              <span>{ageLabel(token.ageSec)} OLD</span>
              <span className={`stage-badge stage-${(token.stage ?? "UNKNOWN").toLowerCase()}`}>
                {token.stage ?? "UNKNOWN"}
              </span>
              <div className="token-sub">
                <span>LIQ {formatCompact(token.liquidity)}</span>
                <span>VOL {formatCompact(token.volume24h)}</span>
                {typeof token.riskScore === "number" && (
                  <span
                    className="risk-score-badge"
                    title="Heuristic display-only score (liquidity + top-holder concentration). Not a real risk model, never used for trading decisions."
                  >
                    RISK {Math.round(token.riskScore)}
                  </span>
                )}
              </div>
            </div>
            <div className="token-price">
              <strong>{formatPrice(token.price)}</strong>
              <span className={token.change1m >= 0 ? "positive" : "negative"}>
                {typeof token.change1m === "number" ? `${token.change1m >= 0 ? "+" : ""}${token.change1m.toFixed(1)}%` : "—"}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}