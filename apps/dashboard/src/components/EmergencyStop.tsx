export interface EmergencyStopProps {
  active: boolean;
  busy: boolean;
  onClick: () => void;
  compact?: boolean;
}

export default function EmergencyStop({
  active,
  busy,
  onClick,
  compact = false,
}: EmergencyStopProps) {
  const label = busy
    ? "ACTIVATING EMERGENCY STOP..."
    : active
      ? "EMERGENCY STOP ACTIVATED"
      : "EMERGENCY STOP";

  return (
    <div
      className={`emergency-stop ${active ? "active" : ""} ${
        busy ? "busy" : ""
      } ${compact ? "compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      {!compact && (
        <div className="panel-header">
          <div>
            <span className="panel-kicker">SAFETY</span>
            <h2>KILL SWITCH</h2>
          </div>
        </div>
      )}

      <button
        type="button"
        className="emergency-stop-button"
        onClick={onClick}
        disabled={busy}
      >
        <span className="emergency-icon">■</span>
        <span className="emergency-label">{label}</span>
      </button>

      {active && (
        <p className="emergency-note">
          ORDER EXECUTION DISABLED — resolve the halt before resuming trading
        </p>
      )}
    </div>
  );
}