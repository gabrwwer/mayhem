import { API_BASE } from "../lib/api";
import { formatTime } from "../lib/format";

export interface ApiStatusProps {
  apiOnline: boolean;
  latencyMs: number | null;
  lastChecked: number | null;
  booting: boolean;
}

export default function ApiStatus({
  apiOnline,
  latencyMs,
  lastChecked,
  booting,
}: ApiStatusProps) {
  const tone = booting ? "idle" : apiOnline ? "ok" : "bad";
  const label = booting
    ? "CONNECTING..."
    : apiOnline
      ? "API ONLINE"
      : "API OFFLINE";

  return (
    <div className="api-status">
      <div className="api-status-head">
        <span className="status-badge" data-tone={tone}>
          {label}
        </span>
        <span className="api-endpoint" title={API_BASE}>
          {API_BASE}
        </span>
      </div>
      <div className="api-status-meta">
        <span>
          LATENCY <strong>{apiOnline && latencyMs !== null ? `${latencyMs}ms` : "N/A"}</strong>
        </span>
        <span>
          CHECKED <strong>{lastChecked ? formatTime(lastChecked) : "—"}</strong>
        </span>
      </div>
    </div>
  );
}