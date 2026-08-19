import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Badge } from "../components/ui/Badge";
import { AsyncPanelBody, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { useSortableRows, sortableHeader } from "../hooks/useSortableRows";
import type { ApiTrade } from "../types/api";
import { formatDateTime, formatPrice, formatSol, shortAddress } from "../lib/format";

type SortKey = "createdAt" | "symbol" | "side" | "amountSol" | "price" | "status";

const SOLSCAN_TX = "https://solscan.io/tx/";

export default function TradesPage() {
  const { trades } = useTerminal();
  const [side, setSide] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const rows = trades.data;
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    return rows.filter((t) => {
      if (side !== "ALL" && t.side !== side) return false;
      if (q && !`${t.symbol} ${t.tokenMint} ${t.signature ?? ""}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [trades.data, side, query]);

  const accessors: Record<SortKey, (t: ApiTrade) => number | string | null> = {
    createdAt: (t) => (t.createdAt ? Date.parse(t.createdAt) : null),
    symbol: (t) => t.symbol,
    side: (t) => t.side,
    amountSol: (t) => t.amountSol,
    price: (t) => t.price,
    status: (t) => t.status,
  };

  const { sorted, sort, toggle } = useSortableRows(filtered, accessors, {
    key: "createdAt",
    dir: "desc",
  });

  const th = (key: SortKey) => sortableHeader(key, sort, toggle);

  return (
    <PageFrame
      meta={`${sorted?.length ?? 0} trades · last 200 · polled every 10s`}
      actions={
        <>
          {(["ALL", "BUY", "SELL"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`mh-btn${side === s ? " mh-btn--primary" : ""}`}
              onClick={() => setSide(s)}
            >
              {s}
            </button>
          ))}
          <input
            className="mh-input"
            style={{ width: 220 }}
            placeholder="symbol, mint or signature"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search trades"
          />
          <button type="button" className="mh-btn" onClick={trades.refresh}>
            Refresh
          </button>
        </>
      }
    >
      <Panel title="Executed Trades">
        <AsyncPanelBody
          loading={trades.loading}
          error={trades.error}
          data={sorted}
          source="GET /api/trades"
          emptyTitle="No trades recorded"
          emptyDetail="The bot has not executed a trade, or none match the filter."
          onRetry={trades.refresh}
        >
          {(rows) => (
            <table className="mh-table">
              <thead>
                <tr>
                  <th {...th("createdAt")}>Time</th>
                  <th {...th("side")}>Side</th>
                  <th {...th("symbol")}>Token</th>
                  <th>Mint</th>
                  <th className="num" {...th("amountSol")}>
                    Size
                  </th>
                  <th className="num">Token Amount</th>
                  <th className="num" {...th("price")}>
                    Price
                  </th>
                  <th {...th("status")}>Status</th>
                  <th>Signature</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="mh-mono">{formatDateTime(t.createdAt)}</td>
                    <td>
                      <Badge tone={t.side === "BUY" ? "ok" : "warn"}>{t.side}</Badge>
                    </td>
                    <td>
                      <Link to={`/token/${t.tokenMint}`} className="mh-mono">
                        {t.symbol}
                      </Link>
                    </td>
                    <td className="mh-mono" title={t.tokenMint}>
                      {shortAddress(t.tokenMint, 4, 4)}
                    </td>
                    <td className="num">
                      <Value value={t.amountSol} format={(n) => formatSol(n, 4)} />
                    </td>
                    <td className="num">
                      <Value value={t.amountToken} format={(n) => n.toLocaleString()} />
                    </td>
                    <td className="num">
                      <Value value={t.price} format={(n) => formatPrice(n)} />
                    </td>
                    <td>
                      <Badge
                        tone={
                          t.status === "CONFIRMED" || t.status === "FILLED"
                            ? "ok"
                            : t.status === "FAILED"
                              ? "bad"
                              : "muted"
                        }
                      >
                        {t.status}
                      </Badge>
                    </td>
                    <td className="mh-mono">
                      {t.signature ? (
                        <a
                          href={`${SOLSCAN_TX}${t.signature}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={t.signature}
                        >
                          {shortAddress(t.signature, 6, 6)}
                        </a>
                      ) : (
                        <span className="mh-na" title="No signature recorded — expected in dry run">
                          none
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncPanelBody>
      </Panel>
    </PageFrame>
  );
}
