import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Stat, StatRow } from "../components/ui/Stat";
import { Badge, Dot } from "../components/ui/Badge";
import { Unavailable, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { COMPONENT_ORDER, type ComponentStatus } from "../types/health";
import { formatDateTime, formatMs, formatUptime } from "../lib/format";

const STATUS_TONE: Record<ComponentStatus, "ok" | "warn" | "bad" | "muted"> = {
  up: "ok",
  degraded: "warn",
  down: "bad",
  unknown: "muted",
};

/**
 * System health console.
 *
 * Every per-component row renders `N/A` unless the API actually reported that
 * component. Nothing here infers health from the fact that the dashboard is
 * loading — the API being reachable says nothing about whether the Geyser
 * stream is connected or the execution queue is draining.
 */
export default function SystemPage() {
  const { health, healthError, telemetry, status, apiOnline, apiLatencyMs } =
    useTerminal();

  const uptimeSec = status.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(status.startedAt)) / 1000))
    : null;

  return (
    <PageFrame meta={apiOnline ? "API reachable" : "API unreachable"}>
      <div style={{ display: "grid", gap: 8, minHeight: 0 }}>
        <StatRow>
          <Stat
            label="API"
            value={apiOnline ? "REACHABLE" : "UNREACHABLE"}
            tone={apiOnline ? "ok" : "bad"}
            sub="dashboard → API"
            large
          />
          <Stat
            label="API RTT"
            value={
              <Value
                value={apiLatencyMs}
                format={formatMs}
                source="client measurement"
                reason="API unreachable"
              />
            }
            sub="client-measured, not RPC latency"
          />
          <Stat
            label="Engine Uptime"
            value={uptimeSec === null ? <Unavailable source="GET /api/status" /> : formatUptime(uptimeSec)}
            sub={status.startedAt ? `since ${formatDateTime(status.startedAt)}` : ""}
          />
          <Stat
            label="Avg Confirm"
            value={
              <Value
                value={telemetry.data?.avgTxConfirmTimeMs ?? null}
                format={formatMs}
                source="GET /api/telemetry"
              />
            }
            sub="transaction confirmation"
          />
          <Stat
            label="Queue Depth"
            value={<Unavailable source="GET /api/health/components" reason="not implemented" />}
            sub="execution engine"
          />
          <Stat
            label="Tokens Tracked"
            value={<Value value={null} format={String} source="GET /api/health/components" />}
            sub="token monitor"
          />
        </StatRow>

        {healthError ? (
          <div className="mh-banner" data-tone="warn">
            <span>
              <strong>Component health unavailable.</strong> {healthError} Every
              component row below therefore reads N/A. Implementing{" "}
              <span className="mh-mono">GET /api/health/components</span> against
              the contract in{" "}
              <span className="mh-mono">apps/dashboard/src/types/health.ts</span>{" "}
              will populate this console with no further UI changes.
            </span>
          </div>
        ) : null}

        <Panel
          title="Component Health"
          meta={health ? <Badge tone="ok">reported</Badge> : <Badge tone="muted">not wired</Badge>}
        >
          <table className="mh-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Status</th>
                <th className="num">Latency</th>
                <th>Last Heartbeat</th>
                <th className="num">Errors</th>
                <th className="num">Reconnects</th>
                <th className="num">Queue</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {COMPONENT_ORDER.map(({ key, label }) => {
                const report = health?.[key];

                return (
                  <tr key={key}>
                    <td className="mh-mono">{label}</td>
                    <td>
                      {report ? (
                        <span className="mh-row" style={{ gap: 6 }}>
                          <Dot
                            tone={STATUS_TONE[report.status]}
                            live={report.status === "up"}
                          />
                          <span className="mh-mono">{report.status.toUpperCase()}</span>
                        </span>
                      ) : (
                        <Unavailable
                          source="GET /api/health/components"
                          reason="component not reported"
                        />
                      )}
                    </td>
                    <td className="num">
                      <Value
                        value={report?.latencyMs ?? null}
                        format={formatMs}
                        source="GET /api/health/components"
                      />
                    </td>
                    <td className="mh-mono">
                      {report?.lastHeartbeatAt ? (
                        formatDateTime(report.lastHeartbeatAt)
                      ) : (
                        <Unavailable source="GET /api/health/components" />
                      )}
                    </td>
                    <td className="num">
                      <Value
                        value={report?.errorCount ?? null}
                        format={(n) => n.toFixed(0)}
                        source="GET /api/health/components"
                      />
                    </td>
                    <td className="num">
                      <Value
                        value={report?.reconnectCount ?? null}
                        format={(n) => n.toFixed(0)}
                        source="GET /api/health/components"
                      />
                    </td>
                    <td className="num">
                      <Value
                        value={report?.queueDepth ?? null}
                        format={(n) => n.toFixed(0)}
                        source="GET /api/health/components"
                      />
                    </td>
                    <td className="mh-truncate">
                      {report?.detail ?? <Unavailable source="GET /api/health/components" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel title="Execution Telemetry" meta={<Badge tone="ok">GET /api/telemetry</Badge>}>
          <table className="mh-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num">Value</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Avg discovery latency", telemetry.data?.avgDiscoveryLatencyMs ?? null, "detection → queue"],
                  ["Avg quote latency", telemetry.data?.avgQuoteLatencyMs ?? null, "route quote round trip"],
                  ["Avg tx build time", telemetry.data?.avgTxBuildTimeMs ?? null, "transaction construction"],
                  ["Avg tx confirm time", telemetry.data?.avgTxConfirmTimeMs ?? null, "broadcast → confirmation"],
                ] as const
              ).map(([label, value, note]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">
                    <Value value={value} format={formatMs} source="GET /api/telemetry" />
                  </td>
                  <td className="mh-mono" style={{ color: "var(--text-mute)" }}>
                    {note}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Successful transactions</td>
                <td className="num">
                  <Value
                    value={telemetry.data?.successfulTransactions ?? null}
                    format={(n) => n.toFixed(0)}
                    source="GET /api/telemetry"
                  />
                </td>
                <td />
              </tr>
              <tr>
                <td>Failed transactions</td>
                <td className="num">
                  <Value
                    value={telemetry.data?.failedTransactions ?? null}
                    format={(n) => n.toFixed(0)}
                    source="GET /api/telemetry"
                  />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </Panel>
      </div>
    </PageFrame>
  );
}
