import ApiStatus from "./ApiStatus";
import { API_BASE } from "../lib/api";
import { formatDateTime, formatTime, formatUptime } from "../lib/format";
import type { NormalizedStatus } from "../types/trading";

export interface SystemStatusProps {
  status: NormalizedStatus;
  apiOnline: boolean;
  latencyMs: number | null;
  lastChecked: number | null;
  booting: boolean;
}

type RowTone = "ok" | "bad" | "warn" | "idle";

function Row({
  label,
  value,
  tone = "idle",
}: {
  label: string;
  value: string;
  tone?: RowTone;
}) {
  return (
    <div className="status-row">
      <span className="status-label">{label}</span>
      <span className="status-value" data-tone={tone}>
        {value}
      </span>
    </div>
  );
}

export default function SystemStatus({
  status,
  apiOnline,
  latencyMs,
  lastChecked,
  booting,
}: SystemStatusProps) {
  const dryRun = status.dryRun || status.mode === "DRY_RUN";

  return (
    <section className="panel system-status-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">SYSTEM</span>
          <h2>STATUS</h2>
        </div>
        <span className="live-indicator" data-online={apiOnline}>
          {apiOnline ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <ApiStatus
        apiOnline={apiOnline}
        latencyMs={latencyMs}
        lastChecked={lastChecked}
        booting={booting}
      />

      <div className="status-rows">
        <Row label="BACKEND" value={API_BASE} />
        <Row
          label="API LATENCY"
          value={apiOnline && latencyMs !== null ? `${latencyMs}ms` : "N/A"}
        />
        <Row
          label="BOT STATUS"
          value={status.botRunning ? "RUNNING" : "STOPPED"}
          tone={status.botRunning ? "ok" : "idle"}
        />
        <Row
          label="TRADING"
          value={status.tradingLive ? "LIVE" : status.tradingEnabled ? "ARMED (DRY RUN)" : "DISABLED"}
          tone={status.tradingLive ? "bad" : status.tradingEnabled ? "warn" : "idle"}
        />
        <Row
          label="DRY RUN"
          value={dryRun ? "YES" : "NO"}
          tone={dryRun ? "warn" : "ok"}
        />
        <Row
          label="EMERGENCY STOP"
          value={status.emergencyStop ? "ACTIVE" : "INACTIVE"}
          tone={status.emergencyStop ? "bad" : "ok"}
        />
        <Row
          label="OPEN POSITIONS"
          value={status.openPositions !== null ? String(status.openPositions) : "N/A"}
        />
        <Row
          label="TOTAL TRADES"
          value={status.totalTrades !== null ? String(status.totalTrades) : "N/A"}
        />
        <Row label="SERVER START" value={formatDateTime(status.startedAt)} />
        <Row label="UPTIME" value={formatUptime(status.uptimeSec)} />
        <Row
          label="LAST CHECK"
          value={lastChecked ? formatTime(lastChecked) : "—"}
        />
      </div>
    </section>
  );
}