import { Link } from "react-router-dom";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Stat, StatRow } from "../components/ui/Stat";
import { Badge, Dot } from "../components/ui/Badge";
import {
  AsyncPanelBody,
  Unavailable,
  Value,
} from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import {
  elapsedSince,
  formatCompact,
  formatCount,
  formatLogTime,
  formatPrice,
  formatSignedSol,
  formatSol,
} from "../lib/format";
import { STAGE_TONE } from "../types/token";

const ACTIVITY_TONE: Record<string, "ok" | "bad" | "warn" | "info" | "muted"> = {
  SUCCESS: "ok",
  ERROR: "bad",
  WARNING: "warn",
  TRADE: "info",
  SYSTEM: "muted",
  INFO: "muted",
};

export default function DashboardPage() {
  const { positions, tokens, balance, telemetry, activity, status } = useTerminal();

  const open = (positions.data ?? []).filter((p) => p.status === "OPEN");

  // Exposure is the sum of SOL committed to positions the API actually
  // reported an amount for. If any open position is missing amountSol the
  // total would understate real exposure, so we surface that explicitly
  // rather than quietly summing what we have.
  const exposureKnown = open.every((p) => p.amountSol !== null);
  const exposure = open.reduce((sum, p) => sum + (p.amountSol ?? 0), 0);

  const unrealizedKnown =
    open.length === 0 || open.every((p) => p.unrealizedPnl !== null);
  const unrealized = open.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

  return (
    <PageFrame
      meta={
        positions.updatedAt
          ? `positions updated ${formatLogTime(positions.updatedAt)}`
          : "awaiting first response"
      }
    >
      <div className="mh-dash">
        {/* ---------- Portfolio band ---------- */}
        <div className="span-12">
          <StatRow>
            <Stat
              label="Wallet SOL"
              value={
                <Value
                  value={balance.data?.sol ?? null}
                  format={(n) => formatSol(n, 4)}
                  source="GET /api/balance"
                />
              }
              sub={status.dryRun ? "simulated balance (DRY_RUN)" : "on-chain"}
              large
            />
            <Stat
              label="Realised P&L"
              value={
                <Value
                  value={telemetry.data?.totalPnl ?? null}
                  format={(n) => formatSignedSol(n)}
                  source="GET /api/telemetry"
                />
              }
              tone={
                telemetry.data?.totalPnl == null
                  ? undefined
                  : telemetry.data.totalPnl >= 0
                    ? "ok"
                    : "bad"
              }
              sub={`win rate ${telemetry.data?.winRate ?? "N/A"}`}
            />
            <Stat
              label="Unrealised P&L"
              value={
                unrealizedKnown ? (
                  formatSignedSol(unrealized)
                ) : (
                  <Unavailable
                    source="GET /api/positions"
                    reason="one or more open positions report no unrealizedPnl"
                  />
                )
              }
              tone={unrealizedKnown ? (unrealized >= 0 ? "ok" : "bad") : undefined}
              sub={`${open.length} open`}
            />
            <Stat
              label="Daily P&L"
              value={<Unavailable source="GET /api/portfolio/equity" reason="not implemented" />}
              sub="requires equity snapshots"
            />
            <Stat
              label="Exposure"
              value={
                exposureKnown ? (
                  formatSol(exposure, 3)
                ) : (
                  <Unavailable
                    source="GET /api/positions"
                    reason="a position is missing amountSol"
                  />
                )
              }
              sub="deployed capital"
            />
            <Stat
              label="Risk Utilisation"
              value={<Unavailable source="GET /api/risk" reason="not implemented" />}
              sub="current vs configured limits"
            />
            <Stat
              label="Total Trades"
              value={
                <Value
                  value={status.totalTrades}
                  format={formatCount}
                  source="GET /api/status"
                />
              }
            />
          </StatRow>
        </div>

        {/* ---------- Open positions ---------- */}
        <div className="span-8 h-md">
          <Panel
            title="Open Positions"
            meta={
              <>
                <span>{open.length} open</span>
                <Link to="/positions" className="mh-btn mh-btn--sm mh-btn--ghost">
                  Manage
                </Link>
              </>
            }
          >
            <AsyncPanelBody
              loading={positions.loading}
              error={positions.error}
              data={open}
              source="GET /api/positions"
              emptyTitle="No open positions"
              emptyDetail="The bot has not opened a position, or none are currently open."
              onRetry={positions.refresh}
            >
              {(rows) => (
                <table className="mh-table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th className="num">Entry</th>
                      <th className="num">Current</th>
                      <th className="num">Size</th>
                      <th className="num">Unreal. P&L</th>
                      <th className="num">Stop</th>
                      <th className="num">TP</th>
                      <th className="num">Age</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/token/${p.tokenMint}`} className="mh-mono">
                            {p.symbol}
                          </Link>
                        </td>
                        <td className="num">
                          <Value value={p.entryPrice} format={(n) => formatPrice(n)} />
                        </td>
                        <td className="num">
                          <Value
                            value={p.currentPrice}
                            format={(n) => formatPrice(n)}
                            source="GET /api/positions"
                            reason="bot has not marked this position"
                          />
                        </td>
                        <td className="num">
                          <Value value={p.amountSol} format={(n) => formatSol(n, 3)} />
                        </td>
                        <td
                          className={`num ${
                            (p.unrealizedPnl ?? 0) >= 0 ? "mh-pos" : "mh-neg"
                          }`}
                        >
                          <Value
                            value={p.unrealizedPnl}
                            format={(n) => formatSignedSol(n)}
                          />
                        </td>
                        {/* Stop-loss and take-profit are engine-side config, not
                            per-position fields on /api/positions. */}
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
                        <td className="num">{elapsedSince(p.openedAt)}</td>
                        <td>
                          <Badge tone="ok">{p.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </AsyncPanelBody>
          </Panel>
        </div>

        {/* ---------- Alerts ---------- */}
        <div className="span-4 h-md">
          <Panel title="Alerts & Signals" meta={<Badge tone="muted">not wired</Badge>}>
            <div className="mh-empty">
              <span className="mh-empty__title">No alerts feed</span>
              <span className="mh-empty__detail">
                The API exposes no alerts endpoint. Risk breaches, stop-loss
                triggers and signal events are not currently retrievable, so
                nothing is shown here rather than a placeholder list.
              </span>
              <span className="mh-empty__source">requires: GET /api/events</span>
            </div>
          </Panel>
        </div>

        {/* ---------- Discovery feed ---------- */}
        <div className="span-7 h-md">
          <Panel
            title="Discovery Feed"
            meta={
              <>
                <span>{tokens.data?.length ?? 0} tracked</span>
                <Link to="/discover" className="mh-btn mh-btn--sm mh-btn--ghost">
                  Scanner
                </Link>
              </>
            }
          >
            <AsyncPanelBody
              loading={tokens.loading}
              error={tokens.error}
              data={(tokens.data ?? []).slice(0, 40)}
              source="GET /api/tokens"
              emptyTitle="No tokens discovered"
              emptyDetail="The bot has not pushed any discoveries to the API yet."
              onRetry={tokens.refresh}
            >
              {(rows) => (
                <table className="mh-table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Stage</th>
                      <th className="num">Price</th>
                      <th className="num">Liquidity</th>
                      <th className="num">Holders</th>
                      <th className="num">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.mint}>
                        <td>
                          <Link to={`/token/${t.mint}`} className="mh-mono">
                            {t.symbol}
                          </Link>
                        </td>
                        <td>
                          <Badge tone={STAGE_TONE[t.stage]}>{t.stage}</Badge>
                        </td>
                        <td className="num">
                          <Value
                            value={t.price}
                            format={(n) => formatPrice(n)}
                            source="bot enrichment"
                            reason="not enriched yet"
                          />
                        </td>
                        <td className="num">
                          <Value
                            value={t.liquidity}
                            format={formatCompact}
                            source="bot enrichment"
                            reason="not enriched yet"
                          />
                        </td>
                        <td className="num">
                          <Value
                            value={t.holders}
                            format={formatCount}
                            source="bot enrichment"
                            reason="not enriched yet"
                          />
                        </td>
                        <td className="num">
                          {t.ageSec === null ? <Unavailable /> : `${t.ageSec}s`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </AsyncPanelBody>
          </Panel>
        </div>

        {/* ---------- Activity ---------- */}
        <div className="span-5 h-md">
          <Panel
            title="Activity"
            meta={
              <>
                <Badge tone="warn" title="Client-side buffer, cleared on refresh">
                  session only
                </Badge>
                <Link to="/activity" className="mh-btn mh-btn--sm mh-btn--ghost">
                  Open
                </Link>
              </>
            }
          >
            {activity.length === 0 ? (
              <div className="mh-empty">
                <span className="mh-empty__title">No events this session</span>
              </div>
            ) : (
              <table className="mh-table">
                <tbody>
                  {activity.slice(0, 60).map((entry) => (
                    <tr key={entry.id}>
                      <td className="mh-mono" style={{ width: 92 }}>
                        {formatLogTime(entry.timestamp)}
                      </td>
                      <td style={{ width: 20 }}>
                        <Dot tone={ACTIVITY_TONE[entry.type] ?? "muted"} />
                      </td>
                      <td>{entry.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
    </PageFrame>
  );
}
