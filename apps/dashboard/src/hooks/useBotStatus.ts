import { useEffect, useRef, useState } from "react";
import { useSystemStatus } from "./useSystemStatus";
import type { ActivityType } from "../types/trading";

/**
 * Wrapper around `useSystemStatus` that slows polling while the tab is hidden.
 *
 * Two things here are deliberate and load-bearing:
 *
 *  - The visibility state is tracked in React state, not read inline during
 *    render. Reading `document.visibilityState` during render made the polling
 *    interval a render-derived value, so it could change without any effect
 *    ever re-running — the interval and the reported interval disagreed.
 *
 *  - The caller's `options` object is never used as an effect dependency.
 *    Call sites pass object literals, which are new every render; depending on
 *    one re-registers listeners on every render and, in the version of
 *    `useSystemStatus` this wraps, re-triggered an immediate poll each time.
 *    That produced a request loop that exhausted the API rate limit.
 */
export function useBotStatus(options: {
  onEvent: (message: string, type?: ActivityType) => void;
  onConnectionRestored?: () => void;
  intervalMs?: number;
}) {
  const { intervalMs = 5000 } = options;

  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;

  const [hidden, setHidden] = useState(
    typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  useEffect(() => {
    const onVisibility = (): void => {
      const nowHidden = document.visibilityState === "hidden";

      setHidden((wasHidden) => {
        if (wasHidden === nowHidden) return wasHidden;
        onEventRef.current(
          nowHidden ? "TAB HIDDEN — REDUCING POLL" : "TAB ACTIVE — RESUMING POLL",
          "INFO",
        );
        return nowHidden;
      });
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // No dependencies: the listener reads everything it needs through refs and
    // the state updater, so it is registered exactly once.
  }, []);

  const effectiveInterval = hidden ? Math.max(30_000, intervalMs) : intervalMs;

  return useSystemStatus({
    onEvent: options.onEvent,
    ...(options.onConnectionRestored
      ? { onConnectionRestored: options.onConnectionRestored }
      : {}),
    intervalMs: effectiveInterval,
  });
}
