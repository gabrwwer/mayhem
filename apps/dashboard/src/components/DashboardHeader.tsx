import type { NormalizedStatus } from "../types/trading";
import type { BusyAction } from "../hooks/useSystemStatus";
import EmergencyStop from "./EmergencyStop";

export interface DashboardHeaderProps {
  apiOnline: boolean;
  status: NormalizedStatus;
  busyAction: BusyAction;
  onStart: () => void;
  onPause: () => void;
  onEmergencyStop: () => void;
}

type PillTone = "ok" | "bad" | "warn" | "idle";

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: PillTone;
}) {
  return (
    <div className="status-pill" data-tone={tone}>
      <span className="pill-label">{label}</span>
      <span className="pill-value">{value}</span>
    </div>
  );
}

export default function DashboardHeader({
  apiOnline,
  status,
  busyAction,
  onStart,
  onPause,
  onEmergencyStop,
}: DashboardHeaderProps) {
  const anyBusy = busyAction !== null;
  const startBusy = busyAction === "start";
  const pauseBusy = busyAction === "pause";

  const modeLabel =
    status.mode === "DRY_RUN"
      ? "DRY RUN"
      : status.mode === "LIVE"
        ? "LIVE"
        : "UNKNOWN";

  const modeTone: PillTone =
    status.mode === "DRY_RUN" ? "warn" : status.mode === "LIVE" ? "bad" : "idle";

  return (
    <header className="terminal-header">
      <div className="brand">
        <div className="brand-mark">M</div>
        <div>
          <div className="brand-title">MAYHEM</div>
          <div className="brand-subtitle">TRADING COMMAND CENTER</div>
        </div>
      </div>

      <div className="header-pills">
        <Pill
          label="API"
          value={apiOnline ? "ONLINE" : "OFFLINE"}
          tone={apiOnline ? "ok" : "bad"}
        />
        <Pill
          label="BOT"
          value={status.botRunning ? "RUNNING" : "STOPPED"}
          tone={status.botRunning ? "ok" : "idle"}
        />
        <Pill
          label="TRADING"
          value={status.tradingLive ? "LIVE" : status.tradingEnabled ? "ARMED (DRY RUN)" : "DISABLED"}
          tone={status.tradingLive ? "bad" : status.tradingEnabled ? "warn" : "idle"}
        />
        <Pill label="MODE" value={modeLabel} tone={modeTone} />
      </div>

      <div className="header-actions" role="group" aria-label="Bot controls">
        <button
          type="button"
          className="header-bot-btn start"
          onClick={onStart}
          disabled={status.botRunning || anyBusy || status.emergencyStop}
          title={
            status.emergencyStop
              ? "Clear emergency stop before starting the bot"
              : "Start the bot"
          }
        >
          {startBusy ? "STARTING..." : "START"}
        </button>

        <button
          type="button"
          className="header-bot-btn pause"
          onClick={onPause}
          disabled={!status.botRunning || anyBusy}
          title="Pause the bot"
        >
          {pauseBusy ? "PAUSING..." : "PAUSE"}
        </button>

        <EmergencyStop
          active={status.emergencyStop}
          busy={busyAction === "emergency"}
          onClick={onEmergencyStop}
          compact
        />
      </div>
    </header>
  );
}