import { useCallback, useMemo } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { apiFetch } from "./lib/api";
import { useActivity } from "./hooks/useActivity";
import { useBotStatus } from "./hooks/useBotStatus";
import { usePolledResource } from "./hooks/usePolledResource";
import { TerminalContext, type TerminalState } from "./terminal-context";

import { normalizeDiscoveredTokens } from "./types/token";
import {
  normalizePositions,
  normalizeTrades,
  normalizeBalance,
  normalizeTelemetry,
} from "./types/api";
import { normalizeComponentHealth } from "./types/health";

import NavRail from "./components/shell/NavRail";
import StatusBar from "./components/shell/StatusBar";

import DashboardPage from "./pages/DashboardPage";
import DiscoverPage from "./pages/DiscoverPage";
import MarketsPage from "./pages/MarketsPage";
import TokenIntelligencePage from "./pages/TokenIntelligencePage";
import PositionsPage from "./pages/PositionsPage";
import TradesPage from "./pages/TradesPage";
import PortfolioPage from "./pages/PortfolioPage";
import RiskPage from "./pages/RiskPage";
import AlertsPage from "./pages/AlertsPage";
import ActivityPage from "./pages/ActivityPage";
import SystemPage from "./pages/SystemPage";
import ConfigPage from "./pages/ConfigPage";
import SettingsPage from "./pages/SettingsPage";

import "./styles/theme.css";
import "./styles/shell.css";

const APP_VERSION = "0.2.0";

export default function App() {
  const { entries, addEntry } = useActivity(500);

  // Must be memoised. An inline arrow here is a new identity every render;
  // the hooks below now defend against that with refs, but keeping the call
  // site stable means the defence is belt-and-braces rather than the only
  // thing standing between this dashboard and a request loop.
  const onConnectionRestored = useCallback(() => {
    addEntry("API CONNECTION RESTORED", "SUCCESS");
  }, [addEntry]);

  const {
    apiOnline,
    latencyMs,
    lastError: apiError,
    status,
    busyAction,
    startBot,
    pauseBot,
    triggerEmergencyStop,
  } = useBotStatus({
    onEvent: addEntry,
    onConnectionRestored,
    intervalMs: 5000,
  });

  // Poll budget. The API allows RATE_LIMIT_MAX (default 120) requests per
  // minute for /api/*, and these intervals are chosen to sit well inside it:
  //
  //   status 5s = 12/min   positions 6s = 10/min   tokens 8s  = 7.5/min
  //   telemetry 15s = 4    trades 20s   = 3        balance 30s = 2
  //   health 30s = 2                              -> ~40/min total
  //
  // That leaves headroom for the page-scoped polls (/config on Risk,
  // /rejections on Alerts) and manual refresh clicks. An earlier, tighter set
  // of intervals blew the limit and the dashboard reported the API as OFFLINE
  // when it was in fact returning 429 — so treat this budget as load-bearing,
  // not cosmetic. Adding another polled endpoint means re-checking the sum.
  const tokens = usePolledResource({
    path: "/tokens",
    normalize: normalizeDiscoveredTokens,
    intervalMs: 8000,
  });

  const positions = usePolledResource({
    path: "/positions",
    normalize: normalizePositions,
    intervalMs: 6000,
  });

  const trades = usePolledResource({
    path: "/trades?limit=200",
    normalize: normalizeTrades,
    intervalMs: 20_000,
  });

  const balance = usePolledResource({
    path: "/balance",
    normalize: normalizeBalance,
    intervalMs: 30_000,
  });

  const telemetry = usePolledResource({
    path: "/telemetry",
    normalize: normalizeTelemetry,
    intervalMs: 15_000,
  });

  // Documented-but-unbuilt endpoint. `optional` turns a 404 into an explicit
  // "not implemented" message instead of a transport error, and the UI keeps
  // rendering N/A rather than inventing component statuses.
  const health = usePolledResource({
    path: "/health/components",
    normalize: normalizeComponentHealth,
    intervalMs: 30_000,
    optional: true,
  });

  const closePosition = useCallback(
    async (positionId: string) => {
      addEntry(`CLOSE POSITION REQUESTED — ${positionId}`, "SYSTEM");
      try {
        await apiFetch(`/positions/${encodeURIComponent(positionId)}/close`, {
          method: "POST",
        });
        addEntry(`CLOSE POSITION ACCEPTED — ${positionId}`, "SUCCESS");
        positions.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        addEntry(`CLOSE POSITION FAILED — ${positionId} — ${message}`, "ERROR");
        throw error;
      }
    },
    [addEntry, positions],
  );

  const value = useMemo<TerminalState>(
    () => ({
      apiOnline,
      apiLatencyMs: latencyMs,
      status,
      busy: busyAction !== null,
      tokens,
      positions,
      trades,
      balance,
      telemetry,
      health: health.data,
      healthError: health.error,
      activity: entries,
      logEvent: addEntry,
      startBot: () => void startBot(),
      pauseBot: () => void pauseBot(),
      emergencyStop: () => void triggerEmergencyStop().catch(() => undefined),
      closePosition,
    }),
    [
      apiOnline,
      latencyMs,
      status,
      busyAction,
      tokens,
      positions,
      trades,
      balance,
      telemetry,
      health.data,
      health.error,
      entries,
      addEntry,
      startBot,
      pauseBot,
      triggerEmergencyStop,
      closePosition,
    ],
  );

  const openPositions = (positions.data ?? []).filter(
    (p) => p.status === "OPEN",
  ).length;

  const walletAddress = null; // Not exposed by /api/balance — see assessment §4.

  return (
    <TerminalContext.Provider value={value}>
      <div className="mh-shell mh-grid-bg">
        <StatusBar
          apiOnline={apiOnline}
          apiLatencyMs={latencyMs}
          apiError={apiError}
          status={status}
          health={health.data}
          walletAddress={walletAddress}
          walletSol={balance.data?.sol ?? null}
          busy={busyAction !== null}
          onEmergencyStop={() => void triggerEmergencyStop().catch(() => undefined)}
        />

        <NavRail
          version={APP_VERSION}
          badges={{
            "/positions": openPositions,
            "/discover": tokens.data?.length ?? 0,
          }}
        />

        <main className="mh-main">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/markets" element={<MarketsPage />} />
            <Route path="/token" element={<TokenIntelligencePage />} />
            <Route path="/token/:mint" element={<TokenIntelligencePage />} />
            <Route path="/positions" element={<PositionsPage />} />
            <Route path="/trades" element={<TradesPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/risk" element={<RiskPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </TerminalContext.Provider>
  );
}
