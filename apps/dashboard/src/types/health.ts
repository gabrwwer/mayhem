/**
 * Contract for `GET /api/health/components`.
 *
 * This type is written before the endpoint exists on purpose: it is the
 * documented requirement the UI is coded against. Until the API serves it,
 * every consumer receives `null` and renders `N/A` — no component is ever
 * shown as healthy on the strength of an assumption.
 *
 * Every numeric field is nullable. `null` means "the backend did not measure
 * this", which is a different statement from `0`.
 */

export type ComponentStatus = "up" | "degraded" | "down" | "unknown";

export interface ComponentReport {
  status: ComponentStatus;
  /** Round-trip or processing latency in ms, or null if not measured. */
  latencyMs: number | null;
  /** ISO timestamp of the last successful heartbeat, or null. */
  lastHeartbeatAt: string | null;
  /** Errors observed since process start, or null if not counted. */
  errorCount: number | null;
  /** Reconnects since process start, or null if not applicable/counted. */
  reconnectCount: number | null;
  /** Pending work items, or null if the component has no queue. */
  queueDepth: number | null;
  /** Free-form component-specific note, e.g. endpoint host or tracked count. */
  detail: string | null;
}

/**
 * Keys mirror the engines named in MAYHEM_UI_SPEC.md. A component the backend
 * does not report is absent from the payload, not defaulted to "up".
 */
export interface ComponentHealth {
  api?: ComponentReport;
  rpc?: ComponentReport;
  rpcBackup?: ComponentReport;
  websocket?: ComponentReport;
  tokenMonitor?: ComponentReport;
  intelligence?: ComponentReport;
  signalEngine?: ComponentReport;
  riskEngine?: ComponentReport;
  executionEngine?: ComponentReport;
  database?: ComponentReport;
}

/** Display order and labels for the System Health console. */
export const COMPONENT_ORDER: { key: keyof ComponentHealth; label: string }[] = [
  { key: "api", label: "API Layer" },
  { key: "rpc", label: "Primary RPC" },
  { key: "rpcBackup", label: "Backup RPC" },
  { key: "websocket", label: "WebSocket / Geyser" },
  { key: "tokenMonitor", label: "Token Monitor" },
  { key: "intelligence", label: "Intelligence" },
  { key: "signalEngine", label: "Signal Engine" },
  { key: "riskEngine", label: "Risk Engine" },
  { key: "executionEngine", label: "Execution Engine" },
  { key: "database", label: "Database" },
];

const STATUSES: ComponentStatus[] = ["up", "degraded", "down", "unknown"];

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeReport(raw: unknown): ComponentReport | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;

  const statusRaw = typeof r.status === "string" ? r.status.toLowerCase() : "";
  const status = (STATUSES as string[]).includes(statusRaw)
    ? (statusRaw as ComponentStatus)
    : "unknown";

  return {
    status,
    latencyMs: asNumberOrNull(r.latencyMs),
    lastHeartbeatAt: asStringOrNull(r.lastHeartbeatAt),
    errorCount: asNumberOrNull(r.errorCount),
    reconnectCount: asNumberOrNull(r.reconnectCount),
    queueDepth: asNumberOrNull(r.queueDepth),
    detail: asStringOrNull(r.detail),
  };
}

/**
 * Parses the endpoint payload. Components the backend omits stay omitted —
 * deliberately not filled with an "unknown" placeholder, so the UI can
 * distinguish "reported as unknown" from "never reported".
 */
export function normalizeComponentHealth(raw: unknown): ComponentHealth {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const out: ComponentHealth = {};

  for (const { key } of COMPONENT_ORDER) {
    const report = normalizeReport(source[key]);
    if (report) out[key] = report;
  }

  return out;
}
