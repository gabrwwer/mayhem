import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

export interface UseApiRequestOptions {
  /** Run immediately on mount. */
  auto?: boolean;
  /** Optional polling interval in ms (implies auto). */
  intervalMs?: number;
}

export function useApiRequest<T>(path: string, options: UseApiRequestOptions = {}) {
  const { auto = false, intervalMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (): Promise<T | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<T>(path);
      setData(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      console.error(`[MAYHEM] Request failed: ${path} — ${message}`);
      return null;
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!auto) return;
    void run();
    if (intervalMs) {
      const timer = window.setInterval(() => void run(), intervalMs);
      return () => window.clearInterval(timer);
    }
    return undefined;
  }, [auto, intervalMs, run]);

  const clear = useCallback(() => {
    setData(null);
    setError(null);
  }, []);

  return { data, loading, error, run, clear };
}