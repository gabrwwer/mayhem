import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import {
  normalizeStatus,
  type ActivityType,
  type NormalizedStatus,
} from "../types/trading";

export type BusyAction = "start" | "pause" | "emergency" | null;

export interface SystemStatusState {
  apiOnline: boolean;
  latencyMs: number | null;
  status: NormalizedStatus;
  lastChecked: number | null;
  booting: boolean;
  /** Message from the most recent failed poll, or null while healthy. */
  lastError: string | null;
}

const INITIAL_STATUS: NormalizedStatus = {
  mode: "UNKNOWN",
  dryRun: false,
  tradingEnabled: false,
  tradingLive: false,
  botRunning: false,
  emergencyStop: false,
  startedAt: null,
  serverTime: null,
  uptimeSec: null,
  openPositions: null,
  totalTrades: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export function useSystemStatus(options: {
  onEvent: (message: string, type?: ActivityType) => void;
  onConnectionRestored?: () => void;
  intervalMs?: number;
}) {
  const { onEvent, onConnectionRestored, intervalMs = 5000 } = options;

  /**
   * Callbacks are held in refs, never in dependency lists.
   *
   * `poll` previously depended on [onEvent, onConnectionRestored]. Callers
   * naturally pass inline arrows, which have a new identity every render, so
   * `poll` was rebuilt every render, the polling effect re-ran, and its
   * `void poll()` fired immediately — whose setState caused the next render.
   * That is an unbounded request loop: one /status call per render, which
   * exhausted the API's rate limit within seconds and surfaced as a 429 that
   * looked like the API being down.
   *
   * Refs make this hook immune to unstable callers rather than relying on
   * every call site remembering to memoise.
   */
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const onConnectionRestoredRef = useRef(onConnectionRestored);
  onConnectionRestoredRef.current = onConnectionRestored;

  const [state, setState] = useState<SystemStatusState>({
    apiOnline: false,
    latencyMs: null,
    status: INITIAL_STATUS,
    lastChecked: null,
    booting: true,
    lastError: null,
  });
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const wasOnline = useRef(false);
  const hasChecked = useRef(false);

  const poll = useCallback(async (): Promise<NormalizedStatus | null> => {
    const startedAt = performance.now();
    try {
      const raw = await apiFetch<unknown>("/status");
      const latencyMs = Math.round(performance.now() - startedAt);
      const status = normalizeStatus(raw);

      setState({
        apiOnline: true,
        latencyMs,
        status,
        lastChecked: Date.now(),
        booting: false,
        lastError: null,
      });

      if (!wasOnline.current) {
        wasOnline.current = true;
        if (hasChecked.current) {
          onEventRef.current("API CONNECTION RESTORED", "SUCCESS");
          onConnectionRestoredRef.current?.();
        } else {
          onEventRef.current("API ONLINE", "SUCCESS");
        }
        hasChecked.current = true;
      }
      return status;
    } catch (error) {
      const message = errorMessage(error);
      setState((prev) => ({
        ...prev,
        apiOnline: false,
        latencyMs: null,
        booting: false,
        lastError: message,
      }));

      // Log the transition to offline AND the very first failure. Previously
      // only the transition was logged, so a dashboard that never managed to
      // connect showed a bare "API OFFLINE" with no reason recorded anywhere —
      // a 401, a 429 and a dead server were indistinguishable to the operator.
      if (wasOnline.current || !hasChecked.current) {
        wasOnline.current = false;
        hasChecked.current = true;
        onEventRef.current(`API OFFLINE — ${message}`, "ERROR");
      }
      return null;
    }
  }, []);

  /**
   * Backoff multiplier applied after a 429. Held in a ref rather than state so
   * adjusting it never triggers a render — a render is what caused the loop
   * this guard exists to contain.
   */
  const backoffRef = useRef(1);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const tick = async (): Promise<void> => {
      const status = await poll();
      if (cancelled) return;

      // Client-side circuit breaker. If the API is shedding load, backing off
      // is the only correct response; polling harder guarantees we stay
      // rate-limited and the operator keeps seeing a blank dashboard.
      if (status === null) {
        backoffRef.current = Math.min(backoffRef.current * 2, 12);
      } else {
        backoffRef.current = 1;
      }

      timer = window.setTimeout(() => void tick(), intervalMs * backoffRef.current);
    };

    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `poll` is stable (empty dep list), so this effect runs once per interval
    // change — not once per render.
  }, [poll, intervalMs]);

  const startBot = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("start");
    onEvent("STARTING BOT...", "SYSTEM");
    try {
      await apiFetch<unknown>("/start", { method: "POST" });
      const status = await poll();
      if (status?.botRunning) {
        onEvent("MAYHEM BOT STARTED", "SUCCESS");
      } else {
        onEvent("BOT START COMMAND ACCEPTED", "SUCCESS");
      }
    } catch (error) {
      onEvent(`BOT START FAILED — ${errorMessage(error)}`, "ERROR");
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, onEvent, poll]);

  const pauseBot = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("pause");
    onEvent("PAUSING BOT...", "SYSTEM");
    try {
      await apiFetch<unknown>("/pause", { method: "POST" });
      const status = await poll();
      if (status && !status.botRunning) {
        onEvent("MAYHEM BOT STOPPED", "SUCCESS");
      } else {
        onEvent("BOT PAUSE COMMAND ACCEPTED", "SUCCESS");
      }
    } catch (error) {
      onEvent(`BOT PAUSE FAILED — ${errorMessage(error)}`, "ERROR");
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, onEvent, poll]);

  const triggerEmergencyStop = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("emergency");
    onEvent("ACTIVATING EMERGENCY STOP...", "WARNING");
    try {
      await apiFetch<unknown>("/emergency-stop", { method: "POST" });
      const status = await poll();
      if (status?.emergencyStop) {
        onEvent("EMERGENCY STOP ACTIVATED", "ERROR");
      } else {
        onEvent("EMERGENCY STOP COMMAND ACCEPTED", "ERROR");
      }
    } catch (error) {
      onEvent(`EMERGENCY STOP FAILED — ${errorMessage(error)}`, "ERROR");
      throw error;
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, onEvent, poll]);

  return {
    ...state,
    busyAction,
    startBot,
    pauseBot,
    triggerEmergencyStop,
    poll,
  };
}