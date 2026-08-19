import { useMemo, useState } from "react";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Badge } from "../components/ui/Badge";
import { AsyncPanelBody } from "../components/ui/States";
import { usePolledResource } from "../hooks/usePolledResource";
import { formatDateTime, shortAddress } from "../lib/format";

/**
 * Filter rejection record as emitted by the bot via POST /internal/telemetry
 * and served back by GET /api/rejections. Shape is loose because the bot
 * forwards arbitrary event bodies; everything is read defensively.
 */
interface Rejection {
  id: string;
  receivedAt: string | null;
  event: string;
  reason: string | null;
  tokenMint: string | null;
  symbol: string | null;
}

function normalizeRejections(raw: unknown): Rejection[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((item, index) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v : null;

    return {
      id: str(r.id) ?? `${str(r.receivedAt) ?? "rejection"}-${index}`,
      receivedAt: str(r.receivedAt),
      event: str(r.event) ?? "UNKNOWN",
      reason: str(r.reason) ?? str(r.detail) ?? str(r.message),
      tokenMint: str(r.tokenMint) ?? str(r.mint),
      symbol: str(r.symbol),
    };
  });
}

/**
 * Alerts.
 *
 * The spec describes a prioritised alert stream covering stop-loss triggers,
 * take-profit fills, smart-money movement and risk breaches. None of that is
 * retrievable: the API has no alerts endpoint. What it does have is the filter
 * rejection feed, which is genuinely useful operationally, so that is shown —
 * clearly labelled as what it is, not dressed up as the alert stream.
 */
export default function AlertsPage() {
  const rejections = usePolledResource({
    path: "/rejections",
    normalize: normalizeRejections,
    intervalMs: 8000,
  });

  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const rows = rejections.data;
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.event} ${r.reason ?? ""} ${r.symbol ?? ""} ${r.tokenMint ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [rejections.data, query]);

  return (
    <PageFrame
      meta={`${filtered?.length ?? 0} records · polled every 8s`}
      actions={
        <>
          <input
            className="mh-input"
            style={{ width: 240 }}
            placeholder="search reasons and tokens"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search rejections"
          />
          <button type="button" className="mh-btn" onClick={rejections.refresh}>
            Refresh
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 8, minHeight: 0 }}>
        <div className="mh-banner" data-tone="warn">
          <span>
            <strong>No alert stream exists.</strong> Stop-loss triggers,
            take-profit fills, risk-limit breaches and smart-money events are not
            exposed by any endpoint, so they are not shown here — an empty alerts
            panel would otherwise read as &ldquo;nothing has gone wrong&rdquo;.
            The filter rejection feed below is a different thing and is labelled
            as such. <span className="mh-mono">requires: GET /api/events</span>
          </span>
        </div>

        <Panel
          title="Filter Rejections"
          meta={<Badge tone="info">GET /api/rejections</Badge>}
        >
          <AsyncPanelBody
            loading={rejections.loading}
            error={rejections.error}
            data={filtered}
            source="GET /api/rejections"
            emptyTitle="No rejections recorded"
            emptyDetail="The bot has not reported a rejected candidate, or the API was restarted (this buffer is in-memory)."
            onRetry={rejections.refresh}
          >
            {(rows) => (
              <table className="mh-table">
                <thead>
                  <tr>
                    <th style={{ width: 200 }}>Received</th>
                    <th style={{ width: 180 }}>Event</th>
                    <th style={{ width: 100 }}>Token</th>
                    <th style={{ width: 120 }}>Mint</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mh-mono">{formatDateTime(r.receivedAt)}</td>
                      <td>
                        <Badge tone="warn">{r.event}</Badge>
                      </td>
                      <td className="mh-mono">{r.symbol ?? "—"}</td>
                      <td className="mh-mono" title={r.tokenMint ?? ""}>
                        {r.tokenMint ? shortAddress(r.tokenMint, 4, 4) : "—"}
                      </td>
                      <td>{r.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </AsyncPanelBody>
        </Panel>
      </div>
    </PageFrame>
  );
}
