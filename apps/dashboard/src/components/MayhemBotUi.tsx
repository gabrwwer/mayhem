import type { BusyAction } from "../hooks/useSystemStatus";
import type { NormalizedStatus } from "../types/trading";
import { formatDateTime, formatUptime } from "../lib/format";
import BotControls from "./BotControls";
import RejectionsPanel from "./RejectionsPanel";

export interface MayhemBotUiProps {
  status: NormalizedStatus;
  apiOnline: boolean;
  latencyMs: number | null;
  busyAction: BusyAction;
  onStart: () => void;
  onPause: () => void;
  onEmergencyStop: () => void;
}

export default function MayhemBotUi({
  status,
  apiOnline,
  latencyMs,
  busyAction,
  onStart,
  onPause,
  onEmergencyStop,
}: MayhemBotUiProps) {
  const modeLabel =
    status.mode === "DRY_RUN"
      ? "DRY RUN"
      : status.mode === "LIVE"
        ? "LIVE"
        : "UNKNOWN";

  const badgeClass = status.emergencyStop
    ? "halt"
    : status.botRunning
      ? "running"
      : "stopped";

  const badgeText = status.emergencyStop
    ? "HALTED"
    : status.botRunning
      ? "RUNNING"
      : "STOPPED";

  return (
    <section className="panel bot-ui-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">MAYHEM BOT</span>
          <h2>BOT COMMAND CENTER</h2>
        </div>
        <span className="bot-mega-badge" data-state={badgeClass}>
          {badgeText}
        </span>
      </div>

      {/* Telemetry — every value comes from GET /api/status, N/A when absent */}
      <div className="bot-telemetry">
        <div className="telemetry-row">
          <span>MODE</span>
          <strong>{modeLabel}</strong>
        </div>
        <div className="telemetry-row">
          <span>DRY RUN</span>
          <strong>{status.dryRun ? "YES" : "NO"}</strong>
        </div>
        <div className="telemetry-row">
          <span>TRADING</span>
          <strong>
            {status.tradingLive ? "LIVE" : status.tradingEnabled ? "ARMED (DRY RUN)" : "DISABLED"}
          </strong>
        </div>
        <div className="telemetry-row">
          <span>UPTIME</span>
          <strong>{formatUptime(status.uptimeSec)}</strong>
        </div>
        <div className="telemetry-row">
          <span>SERVER START</span>
          <strong>{formatDateTime(status.startedAt)}</strong>
        </div>
        <div className="telemetry-row">
          <span>OPEN POSITIONS</span>
          <strong>
            {status.openPositions !== null ? String(status.openPositions) : "N/A"}
          </strong>
        </div>
        <div className="telemetry-row">
          <span>TOTAL TRADES</span>
          <strong>
            {status.totalTrades !== null ? String(status.totalTrades) : "N/A"}
          </strong>
        </div>
        <div className="telemetry-row">
          <span>API</span>
          <strong>
            {apiOnline
              ? latencyMs !== null
                ? `${latencyMs}ms`
                : "ONLINE"
              : "OFFLINE"}
          </strong>
        </div>
      </div>

      <BotControls
        botRunning={status.botRunning}
        emergencyStop={status.emergencyStop}
        busyAction={busyAction}
        onStart={onStart}
        onPause={onPause}
        onEmergencyStop={onEmergencyStop}
      />

      <div style={{ marginTop: 12 }}>
        <RejectionsPanel />
      </div>

      {/* Future modules — visible but honest: no backend endpoint yet */}
      <div className="bot-module-unavailable">
        <span className="module-name">AI STRATEGY MODULE</span>
        <span className="module-note">NOT CONNECTED — REQUIRES BACKEND ENDPOINT</span>
      </div>
      <div className="bot-module-unavailable">
        <span className="module-name">RISK CONFIG</span>
        <span className="module-note">NOT CONNECTED — REQUIRES BACKEND ENDPOINT</span>
      </div>
    </section>
  );
}