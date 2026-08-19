import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ApiTelemetry } from "../types/api";

export default function DebugPanel() {
  const [status, setStatus] = useState<unknown | null>(null);
  const [telemetry, setTelemetry] = useState<ApiTelemetry | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchAll() {
      setLoading(true);
      try {
        const [s, t] = await Promise.all([api.getStatus(), api.getTelemetry()]);
        if (cancelled) return;
        setStatus(s ?? null);
        setTelemetry(t as ApiTelemetry);
      } catch (err) {
        // swallow — debug panel should not break app
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    const timer = window.setInterval(fetchAll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="panel" style={{ minWidth: 320 }}>
      <div className="panel-header">
        <div>
          <div className="panel-kicker">DEBUG</div>
          <h2>Last Poll</h2>
        </div>
        <div className="panel-actions" />
      </div>

      {loading ? (
        <div>Loading...</div>
      ) : (
        <div style={{ fontSize: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Telemetry:</strong> {telemetry ? String(telemetry.totalPnl ?? "—") : "—"}
          </div>
          <details>
            <summary>Raw status</summary>
            <pre style={{ maxHeight: 220, overflow: "auto" }}>{JSON.stringify(status, null, 2)}</pre>
          </details>
          <details>
            <summary>Raw telemetry</summary>
            <pre style={{ maxHeight: 220, overflow: "auto" }}>{JSON.stringify(telemetry, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
