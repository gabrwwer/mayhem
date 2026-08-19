import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { NormalizedStatus } from "../../types/trading";
import type { ComponentHealth } from "../../types/health";
import { Dot } from "../ui/Badge";
import { Unavailable } from "../ui/States";
import { formatMs } from "../../lib/format";

type Tone = "ok" | "bad" | "warn" | "info" | "muted";

interface StatusBarProps {
  apiOnline: boolean;
  /** Client-measured HTTP round trip to /api/status. Not RPC latency. */
  apiLatencyMs: number | null;
  /** Message from the last failed poll. Distinguishes 401/429 from unreachable. */
  apiError: string | null;
  status: NormalizedStatus;
  /** Server-reported component health. Null until /api/health/components answers. */
  health: ComponentHealth | null;
  /** Wallet public key, if the backend exposes one. */
  walletAddress: string | null;
  walletSol: number | null;
  busy: boolean;
  onEmergencyStop: () => void;
}

function Cell({
  label,
  tone = "muted",
  live = false,
  children,
  title,
}: {
  label: string;
  tone?: Tone;
  live?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="mh-scell" title={title}>
      <span className="mh-scell__label">{label}</span>
      <span className="mh-scell__value" data-tone={tone}>
        <Dot tone={tone === "muted" ? "neutral" : tone} live={live} />
        {children}
      </span>
    </div>
  );
}

/**
 * Persistent global status bar.
 *
 * Every cell reports either a real measurement or `N/A`. Nothing here is
 * inferred or defaulted — in particular RPC and WebSocket health are shown as
 * unavailable until the API actually reports them, because a green dot that
 * doesn't correspond to a real probe is worse than no dot at all.
 */
/**
 * Turns a transport failure into something an operator can act on.
 *
 * "OFFLINE" for every failure mode is close to useless: a wrong token, a
 * breached rate limit and a dead process need three different responses.
 */
function describeApiFailure(error: string | null): { label: string; hint: string } {
  if (!error) {
    return { label: "OFFLINE", hint: "No response from the API." };
  }
  if (error.includes("401")) {
    return {
      label: "AUTH FAIL",
      hint: "401 Unauthorized — VITE_API_TOKEN does not match API_AUTH_TOKEN / API_KEYS, or the dev server was not restarted after the token changed.",
    };
  }
  if (error.includes("429")) {
    return {
      label: "RATE LIMITED",
      hint: "429 Too Many Requests — the dashboard exceeded RATE_LIMIT_MAX. The API is healthy; this is a client polling problem.",
    };
  }
  if (error.includes("503")) {
    return {
      label: "NO AUTH CFG",
      hint: "503 — the API has no credentials configured. Set API_AUTH_TOKEN or API_KEYS.",
    };
  }
  return { label: "OFFLINE", hint: error };
}

export default function StatusBar({
  apiOnline,
  apiLatencyMs,
  apiError,
  status,
  health,
  walletAddress,
  walletSol,
  busy,
  onEmergencyStop,
}: StatusBarProps) {
  // `tradingLive` is re-derived client-side (tradingEnabled AND NOT dryRun),
  // so a backend gating bug cannot make a dry run look live or vice versa.
  const mode = status.mode === "UNKNOWN" ? "unknown" : status.tradingLive ? "live" : "dry";
  const modeLabel =
    mode === "live" ? "● LIVE — REAL CAPITAL" : mode === "dry" ? "◐ DRY RUN" : "? MODE UNKNOWN";

  const failure = describeApiFailure(apiError);
  const rpc = health?.rpc ?? null;
  const ws = health?.websocket ?? null;

  const engineTone: Tone = status.emergencyStop
    ? "bad"
    : status.botRunning
      ? "ok"
      : "warn";
  const engineLabel = status.emergencyStop
    ? "HALTED"
    : status.botRunning
      ? "RUNNING"
      : "PAUSED";

  return (
    <header className="mh-statusbar" data-mode={mode === "live" ? "live" : undefined}>
      <div className="mh-brand">
        <span className="mh-brand__mark">M</span>
        <span className="mh-brand__name">MAYHEM</span>
      </div>

      <Cell label="Network" tone="info" title="Configured Solana cluster">
        SOLANA MAINNET
      </Cell>

      <Cell
        label="API"
        tone={apiOnline ? "ok" : "bad"}
        live={apiOnline}
        title={apiOnline ? "Dashboard → API reachability" : failure.hint}
      >
        {apiOnline ? "ONLINE" : failure.label}
      </Cell>

      <Cell
        label="API RTT"
        tone={
          apiLatencyMs === null
            ? "muted"
            : apiLatencyMs > 500
              ? "bad"
              : apiLatencyMs > 200
                ? "warn"
                : "ok"
        }
        title="Client-measured HTTP round trip to /api/status. This is not RPC latency."
      >
        {apiLatencyMs === null ? <Unavailable reason="API unreachable" /> : formatMs(apiLatencyMs)}
      </Cell>

      <Cell
        label="RPC"
        tone={rpc ? (rpc.status === "up" ? "ok" : rpc.status === "degraded" ? "warn" : "bad") : "muted"}
        title="Solana RPC endpoint health as reported by the API"
      >
        {rpc ? (
          <>
            {rpc.status.toUpperCase()}
            {rpc.latencyMs !== null ? ` ${formatMs(rpc.latencyMs)}` : ""}
          </>
        ) : (
          <Unavailable source="GET /api/health/components" reason="not reported" />
        )}
      </Cell>

      <Cell
        label="WS"
        tone={ws ? (ws.status === "up" ? "ok" : ws.status === "degraded" ? "warn" : "bad") : "muted"}
        live={ws?.status === "up"}
        title="Geyser / WebSocket stream health as reported by the API"
      >
        {ws ? (
          ws.status.toUpperCase()
        ) : (
          <Unavailable source="GET /api/health/components" reason="not reported" />
        )}
      </Cell>

      <Cell
        label="Wallet"
        tone={walletAddress ? "ok" : "muted"}
        title={walletAddress ?? "No wallet address exposed by the API"}
      >
        {walletAddress ? (
          <>
            {walletAddress.slice(0, 4)}…{walletAddress.slice(-4)}
            {walletSol !== null ? ` · ${walletSol.toFixed(3)} SOL` : ""}
          </>
        ) : (
          <Unavailable source="GET /api/balance" reason="address not exposed" />
        )}
      </Cell>

      <Cell label="Engine" tone={engineTone} live={status.botRunning && !status.emergencyStop}>
        {engineLabel}
      </Cell>

      <div className="mh-mode" data-mode={mode} title="Execution mode — DRY RUN simulates, LIVE spends real SOL">
        {modeLabel}
      </div>

      <div className="mh-statusbar__actions">
        <button
          type="button"
          className="mh-btn mh-btn--danger"
          onClick={onEmergencyStop}
          disabled={busy || status.emergencyStop}
          title={
            status.emergencyStop
              ? "Emergency stop is already active"
              : "Halt the engine and block all new entries"
          }
        >
          {status.emergencyStop ? "HALTED" : "EMERGENCY STOP"}
        </button>
        <Link to="/settings" className="mh-btn mh-btn--ghost" title="Settings">
          ⚙
        </Link>
      </div>
    </header>
  );
}
