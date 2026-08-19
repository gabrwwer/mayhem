import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Stat, StatRow } from "../components/ui/Stat";
import { Badge } from "../components/ui/Badge";
import ConfirmDialog from "../components/ConfirmDialog";
import { AsyncPanelBody, Unavailable, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { useSortableRows, sortableHeader } from "../hooks/useSortableRows";
import type { ApiPosition } from "../types/api";
import {
  elapsedSince,
  formatPrice,
  formatSignedSol,
  formatSol,
  shortAddress,
} from "../lib/format";

type SortKey =
  | "symbol"
  | "status"
  | "entryPrice"
  | "currentPrice"
  | "amountSol"
  | "unrealizedPnl"
  | "openedAt";

type Filter = "OPEN" | "CLOSED" | "ALL";

export default function PositionsPage() {
  const { positions, closePosition, status } = useTerminal();
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [pendingClose, setPendingClose] = useState<ApiPosition | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const all = positions.data;
    if (!all) return null;
    if (filter === "ALL") return all;
    return all.filter((p) => p.status === filter);
  }, [positions.data, filter]);

  const open = (positions.data ?? []).filter((p) => p.status === "OPEN");
  const exposureKnown = open.every((p) => p.amountSol !== null);
  const exposure = open.reduce((sum, p) => sum + (p.amountSol ?? 0), 0);
  const unrealizedKnown =
    open.length === 0 || open.every((p) => p.unrealizedPnl !== null);
  const unrealized = open.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const profitable = open.filter((p) => (p.unrealizedPnl ?? 0) > 0).length;

  const accessors: Record<SortKey, (p: ApiPosition) => number | string | null> = {
    symbol: (p) => p.symbol,
    status: (p) => p.status,
    entryPrice: (p) => p.entryPrice,
    currentPrice: (p) => p.currentPrice,
    amountSol: (p) => p.amountSol,
    unrealizedPnl: (p) => p.unrealizedPnl,
    openedAt: (p) => (p.openedAt ? Date.parse(p.openedAt) : null),
  };

  const { sorted, sort, toggle } = useSortableRows(rows, accessors, {
    key: "openedAt",
    dir: "desc",
  });

  const th = (key: SortKey) => sortableHeader(key, sort, toggle);

  async function confirmClose() {
    if (!pendingClose) return;
    setBusy(true);
    try {
      await closePosition(pendingClose.id);
      setPendingClose(null);
    } catch {
      // The failure is already recorded in the activity log by closePosition.
      // Keep the dialog open so the operator sees the action did not succeed.
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      meta={`${sorted?.length ?? 0} shown · polled every 4s`}
      actions={
        <>
          {(["OPEN", "CLOSED", "ALL"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`mh-btn${filter === f ? " mh-btn--primary" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          <button type="button" className="mh-btn" onClick={positions.refresh}>
            Refresh
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 8, minHeight: 0 }}>
        <StatRow>
          <Stat
            label="Unrealised P&L"
            value={
              unrealizedKnown ? (
                formatSignedSol(unrealized)
              ) : (
                <Unavailable
                  source="GET /api/positions"
                  reason="a position reports no unrealizedPnl"
                />
              )
            }
            tone={unrealizedKnown ? (unrealized >= 0 ? "ok" : "bad") : undefined}
            sub="across open positions"
            large
          />
          <Stat
            label="Open Positions"
            value={String(open.length)}
            sub={`${profitable} profitable · ${open.length - profitable} at or below entry`}
          />
          <Stat
            label="Total Exposure"
            value={
              exposureKnown ? (
                formatSol(exposure, 3)
              ) : (
                <Unavailable source="GET /api/positions" reason="missing amountSol" />
              )
            }
            sub="deployed capital"
          />
          <Stat
            label="Avg MAYHEM Score"
            value={<Unavailable source="MAYHEM Score service" reason="does not exist" />}
            sub="no scoring backend"
          />
        </StatRow>

        <Panel
          title="Positions"
          meta={
            status.dryRun ? <Badge tone="sim">dry run</Badge> : <Badge tone="bad">live</Badge>
          }
        >
          <AsyncPanelBody
            loading={positions.loading}
            error={positions.error}
            data={sorted}
            source="GET /api/positions"
            emptyTitle={`No ${filter.toLowerCase()} positions`}
            emptyDetail="Nothing matches the current filter."
            onRetry={positions.refresh}
          >
            {(list) => (
              <table className="mh-table">
                <thead>
                  <tr>
                    <th {...th("symbol")}>Token</th>
                    <th>Mint</th>
                    <th className="num" {...th("entryPrice")}>
                      Entry
                    </th>
                    <th className="num" {...th("currentPrice")}>
                      Current
                    </th>
                    <th className="num" {...th("amountSol")}>
                      Size
                    </th>
                    <th className="num">Qty</th>
                    <th className="num" {...th("unrealizedPnl")}>
                      Unreal. P&L
                    </th>
                    <th className="num">P&L %</th>
                    <th className="num">Stop</th>
                    <th className="num">TP</th>
                    <th className="num">Trailing</th>
                    <th className="num">Score</th>
                    <th className="num" {...th("openedAt")}>
                      Age
                    </th>
                    <th {...th("status")}>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => {
                    const pnlPct =
                      p.entryPrice && p.currentPrice && p.entryPrice !== 0
                        ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
                        : null;

                    return (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/token/${p.tokenMint}`} className="mh-mono">
                            {p.symbol}
                          </Link>
                        </td>
                        <td className="mh-mono" title={p.tokenMint}>
                          {shortAddress(p.tokenMint, 4, 4)}
                        </td>
                        <td className="num">
                          <Value value={p.entryPrice} format={(n) => formatPrice(n)} />
                        </td>
                        <td className="num">
                          <Value
                            value={p.currentPrice}
                            format={(n) => formatPrice(n)}
                            source="GET /api/positions"
                            reason="position not marked"
                          />
                        </td>
                        <td className="num">
                          <Value value={p.amountSol} format={(n) => formatSol(n, 3)} />
                        </td>
                        <td className="num">
                          <Value value={p.quantity} format={(n) => n.toLocaleString()} />
                        </td>
                        <td
                          className={`num ${
                            (p.unrealizedPnl ?? 0) >= 0 ? "mh-pos" : "mh-neg"
                          }`}
                        >
                          <Value value={p.unrealizedPnl} format={(n) => formatSignedSol(n)} />
                        </td>
                        <td className={`num ${(pnlPct ?? 0) >= 0 ? "mh-pos" : "mh-neg"}`}>
                          <Value
                            value={pnlPct}
                            format={(n) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`}
                            source="derived from entry/current"
                            reason="current price unavailable"
                          />
                        </td>
                        {/* Exit parameters live in the bot's config, not on the
                            position record. Showing the global config values
                            here would imply per-position stops that may not
                            match what the engine will actually do. */}
                        <td className="num">
                          <Unavailable
                            source="GET /api/positions"
                            reason="stopLoss not returned per position"
                          />
                        </td>
                        <td className="num">
                          <Unavailable
                            source="GET /api/positions"
                            reason="takeProfit not returned per position"
                          />
                        </td>
                        <td className="num">
                          <Unavailable
                            source="GET /api/positions"
                            reason="trailingStop not returned per position"
                          />
                        </td>
                        <td className="num">
                          <Unavailable source="MAYHEM Score service" reason="does not exist" />
                        </td>
                        <td className="num">{elapsedSince(p.openedAt)}</td>
                        <td>
                          <Badge tone={p.status === "OPEN" ? "ok" : "muted"}>{p.status}</Badge>
                        </td>
                        <td>
                          <div className="mh-row" style={{ gap: 4 }}>
                            <button
                              type="button"
                              className="mh-btn mh-btn--sm"
                              disabled
                              title="No modify endpoint exists on the API (see assessment §4)"
                            >
                              Modify
                            </button>
                            <button
                              type="button"
                              className="mh-btn mh-btn--sm"
                              disabled
                              title="No partial-close endpoint exists on the API (see assessment §4)"
                            >
                              Partial
                            </button>
                            <button
                              type="button"
                              className="mh-btn mh-btn--sm mh-btn--danger"
                              disabled={p.status !== "OPEN"}
                              onClick={() => setPendingClose(p)}
                            >
                              Close
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </AsyncPanelBody>
        </Panel>

        <div className="mh-banner" data-tone="info">
          <span>
            <strong>Modify and partial close are disabled</strong> because the
            API exposes no endpoint for either. Only full close
            (<span className="mh-mono">POST /api/positions/:id/close</span>) is
            implemented. Per-position stop loss, take profit, trailing stop and
            MAYHEM Score are not returned by the backend and are shown as N/A
            rather than filled from global config.
          </span>
        </div>
      </div>

      <ConfirmDialog
        open={pendingClose !== null}
        title="Close position"
        destructive
        busy={busy}
        confirmLabel="Close position"
        onCancel={() => setPendingClose(null)}
        onConfirm={() => void confirmClose()}
        body={
          pendingClose ? (
            <>
              <p style={{ marginTop: 0 }}>
                Close <strong>{pendingClose.symbol}</strong>{" "}
                <span className="mh-mono">{shortAddress(pendingClose.tokenMint)}</span>?
              </p>
              <dl className="mh-dl">
                <dt>Size</dt>
                <dd>
                  <Value value={pendingClose.amountSol} format={(n) => formatSol(n, 4)} />
                </dd>
                <dt>Entry</dt>
                <dd>
                  <Value value={pendingClose.entryPrice} format={(n) => formatPrice(n)} />
                </dd>
                <dt>Unrealised</dt>
                <dd>
                  <Value
                    value={pendingClose.unrealizedPnl}
                    format={(n) => formatSignedSol(n)}
                  />
                </dd>
                <dt>Mode</dt>
                <dd>{status.dryRun ? "DRY RUN — simulated" : "LIVE — real capital"}</dd>
              </dl>
              <p style={{ marginBottom: 0 }}>
                {status.dryRun
                  ? "The engine is in dry run, so this marks the position closed in bot state without broadcasting a transaction."
                  : "The engine is LIVE. This will result in a real on-chain sell."}
              </p>
            </>
          ) : null
        }
      />
    </PageFrame>
  );
}
