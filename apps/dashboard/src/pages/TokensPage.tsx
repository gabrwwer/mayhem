import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { normalizeMarketToken, type MarketToken } from "../types/trading";
import "../styles/tokens.css";

type SortKey = keyof MarketToken | "volume24h" | "marketCap";

export default function TokensPage() {
  const [tokens, setTokens] = useState<MarketToken[]>([]);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("marketCap");
  const [sortDesc, setSortDesc] = useState(true);
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      await api.clearTokens();
      setTokens([]);
    } catch (e) {
      // surfaced via the page's own error state would require more plumbing;
      // for now fail silently like the existing fetch loop does.
    } finally {
      setClearing(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    let timer: number | null = null;

    const fetch = async () => {
      try {
        const data = await api.getTokens();
        if (!mounted) return;
        if (Array.isArray(data)) setTokens(data.map(normalizeMarketToken));
      } catch (e) {
        // ignore
      } finally {
        timer = window.setTimeout(fetch, 5000);
      }
    };

    fetch();

    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? tokens.filter((t) =>
          [t.symbol, t.name, t.address].some((v) => (v ?? "").toLowerCase().includes(q)),
        )
      : tokens;
  }, [search, tokens]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const va = (a as any)[sortKey] ?? 0;
      const vb = (b as any)[sortKey] ?? 0;
      if (typeof va === "string" && typeof vb === "string") {
        return sortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
      }
      return sortDesc ? Number(vb) - Number(va) : Number(va) - Number(vb);
    });
  }, [filtered, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc(!sortDesc);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  return (
    <div className="tokens-page">
      <div className="tokens-header">
        <h2>TOKENS</h2>
        <div className="tokens-controls">
          <input
            placeholder="Search tokens or address..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="clear-tokens-button"
            onClick={handleClear}
            disabled={clearing}
            title="Clear all discovered tokens from the bot's memory"
          >
            {clearing ? "CLEARING..." : "CLEAR"}
          </button>
        </div>
      </div>

      <div className="tokens-table-wrapper">
        <table className="tokens-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort("symbol")}>Token</th>
              <th onClick={() => toggleSort("stage")}>STAGE</th>
              <th onClick={() => toggleSort("marketCap")}>MCAP</th>
              <th onClick={() => toggleSort("price")}>PRICE</th>
              <th onClick={() => toggleSort("ageSec")}>AGE</th>
              <th onClick={() => toggleSort("volume24h")}>VOLUME</th>
              <th onClick={() => toggleSort("liquidity")}>LIQUIDITY</th>
              <th onClick={() => toggleSort("change1m")}>1M</th>
              <th onClick={() => toggleSort("change5m")}>5M</th>
              <th onClick={() => toggleSort("change15m")}>15M</th>
              <th onClick={() => toggleSort("riskScore")} title="Heuristic display-only score — not a real risk model, never used for trading decisions">
                RISK
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id}>
                <td className="token-cell">
                  <div className="token-symbol">{t.symbol}</div>
                  <div className="token-name">{t.name}</div>
                </td>
                <td>
                  <span className={`stage-badge stage-${(t.stage ?? "UNKNOWN").toLowerCase()}`}>
                    {t.stage ?? "UNKNOWN"}
                  </span>
                </td>
                <td>${Number(t.marketCap ?? t.marketCap).toLocaleString()}</td>
                <td>${(t.price ?? 0).toFixed(6)}</td>
                <td>{Math.round((t.ageSec ?? 0) / 3600)}h</td>
                <td>${(t.volume24h ?? 0).toLocaleString()}</td>
                <td>${(t.liquidity ?? 0).toLocaleString()}</td>
                <td className={t.change1m >= 0 ? "positive" : "negative"}>{t.change1m?.toFixed(1)}%</td>
                <td className={t.change5m >= 0 ? "positive" : "negative"}>{t.change5m?.toFixed(1)}%</td>
                <td className={t.change15m >= 0 ? "positive" : "negative"}>{t.change15m?.toFixed(1)}%</td>
                <td>
                  {typeof t.riskScore === "number" ? (
                    <span
                      className="risk-score-badge"
                      title="Heuristic display-only score. Not a real risk model, never used for trading decisions."
                    >
                      {Math.round(t.riskScore)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
