import { createContext, useContext } from "react";
import type { NormalizedStatus, ActivityEntry, ActivityType } from "./types/trading";
import type { DiscoveredToken } from "./types/token";
import type { ComponentHealth } from "./types/health";
import type { PolledResource } from "./hooks/usePolledResource";
import type { ApiPosition, ApiTrade, ApiBalance, ApiTelemetry } from "./types/api";

/**
 * Shared terminal state.
 *
 * Lives above the router so polling continues and data survives while the
 * operator moves between sections — switching from Discover to Positions must
 * not re-open every connection and reset every table.
 */
export interface TerminalState {
  apiOnline: boolean;
  apiLatencyMs: number | null;
  status: NormalizedStatus;
  busy: boolean;

  tokens: PolledResource<DiscoveredToken[]>;
  positions: PolledResource<ApiPosition[]>;
  trades: PolledResource<ApiTrade[]>;
  balance: PolledResource<ApiBalance>;
  telemetry: PolledResource<ApiTelemetry>;
  /** Null until GET /api/health/components exists. Never defaulted to healthy. */
  health: ComponentHealth | null;
  healthError: string | null;

  activity: ActivityEntry[];
  logEvent: (message: string, type?: ActivityType) => void;

  startBot: () => void;
  pauseBot: () => void;
  emergencyStop: () => void;
  closePosition: (positionId: string) => Promise<void>;
}

export const TerminalContext = createContext<TerminalState | null>(null);

export function useTerminal(): TerminalState {
  const value = useContext(TerminalContext);
  if (!value) {
    throw new Error("useTerminal must be used inside <TerminalProvider>");
  }
  return value;
}
