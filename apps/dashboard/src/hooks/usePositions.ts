import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import type { Position } from "../types/trading";

export function usePositions(options: { intervalMs?: number } = {}) {
  const { intervalMs = 3000 } = options;
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<unknown>("/positions");
      // Empty array is valid — do not treat as an error.
      if (!mounted.current) return;
      setPositions(Array.isArray(data) ? (data as Position[]) : []);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "Positions unavailable";
      setError(message);
      console.error("[MAYHEM] Position refresh failed:", message);
    } finally {
      if (!mounted.current) return;
      setLoading(false);
      setLastUpdated(Date.now());
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { positions, loading, error, lastUpdated, refresh };
}