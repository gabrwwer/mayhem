import type { BusyAction } from "../hooks/useSystemStatus";

export interface BotControlsProps {
  botRunning: boolean;
  emergencyStop: boolean;
  busyAction: BusyAction;
  onStart: () => void;
  onPause: () => void;
  onEmergencyStop: () => void;
}

export default function BotControls({
  botRunning,
  emergencyStop,
  busyAction,
  onStart,
  onPause,
  onEmergencyStop,
}: BotControlsProps) {
  const anyBusy = busyAction !== null;
  const startBusy = busyAction === "start";
  const pauseBusy = busyAction === "pause";
  const stopBusy = busyAction === "emergency";

  return (
    <section className="panel bot-controls-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">BOT CONTROL</span>
          <h2>BOT STATUS</h2>
        </div>
        <span
          className={`bot-state-badge ${botRunning ? "running" : "stopped"}`}
          data-testid="bot-state"
        >
          {botRunning ? "RUNNING" : "STOPPED"}
        </span>
      </div>

      {emergencyStop && (
        <div className="bot-halt-banner">TRADING HALTED — EMERGENCY STOP ACTIVE</div>
      )}

      <div className="bot-actions">
        <button
          type="button"
          className="bot-button start"
          onClick={onStart}
          disabled={botRunning || anyBusy || emergencyStop}
          title={
            emergencyStop
              ? "Clear emergency stop before starting the bot"
              : undefined
          }
        >
          {startBusy ? "STARTING BOT..." : "START BOT"}
        </button>

        <button
          type="button"
          className="bot-button pause"
          onClick={onPause}
          disabled={!botRunning || anyBusy}
        >
          {pauseBusy ? "STOPPING BOT..." : "PAUSE BOT"}
        </button>

        <button
          type="button"
          className="bot-button stop"
          onClick={onEmergencyStop}
          disabled={anyBusy}
        >
          {stopBusy
            ? "ACTIVATING EMERGENCY STOP..."
            : emergencyStop
              ? "EMERGENCY STOP ACTIVE"
              : "EMERGENCY STOP"}
        </button>
      </div>
    </section>
  );
}