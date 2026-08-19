import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

export interface PolledResource<T> {
  /** null until the first successful response. Never a fabricated default. */
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Wall-clock time of the last successful response. */
  updatedAt: number | null;
  refresh: () => void;
}

interface Options<T> {
  /** Path relative to API_BASE, e.g. "/positions" (API_BASE already ends /api). */
  path: string;
  /** Pure transform from the raw payload to the domain type. */
  normalize: (raw: unknown) => T;
  intervalMs?: number;
  /** Skip polling entirely, e.g. when a prerequisite id is missing. */
  enabled?: boolean;
  /**
   * Treat a 404 as "endpoint not implemented" and surface it as such rather
   * than as a transport error. Used for the endpoints documented in
   * docs/MAYHEM_UI_ASSESSMENT.md that do not exist yet.
   */
  optional?: boolean;
}

/**
 * Polling data source with honest failure semantics.
 *
 * Deliberate choices:
 *  - `data` stays `null` until real data arrives; there is no seed value that
 *    could be mistaken for a reading.
 *  - a failed poll does NOT clear previously good data, but it does set
 *    `error`, so a panel can show the last known value alongside a staleness
 *    warning instead of silently displaying stale numbers as current.
 *  - polling backs off while the tab is hidden.
 */
export function usePolledResource<T>({
  path,
  normalize,
  intervalMs = 5000,
  enabled = true,
  optional = false,
}: Options<T>): PolledResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;

  const inFlight = useRef(false);
  const mounted = useRef(true);

  /**
   * Consecutive-failure backoff multiplier, capped at 12x.
   *
   * When the API returns 429 it is shedding load. Continuing to poll at the
   * normal rate guarantees the limit stays breached and the operator keeps
   * looking at a blank panel. Backing off is the only response that recovers.
   */
  const backoff = useRef(1);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;

    try {
      const raw = await apiFetch<unknown>(path);
      if (!mounted.current) return;
      setData(normalizeRef.current(raw));
      setError(null);
      setUpdatedAt(Date.now());
      backoff.current = 1;
    } catch (err) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "Request failed";

      // A 404 on an endpoint marked `optional` is a known gap, not a fault,
      // and must not trigger backoff — it will never start working within
      // this session, and slowing the poll would delay recovery of the
      // endpoints that do exist once the build changes.
      const notImplemented = optional && /\b404\b/.test(message);

      if (!notImplemented) {
        backoff.current = Math.min(backoff.current * 2, 12);
      }

      setError(
        notImplemented
          ? `Endpoint not implemented on this API build (${path}).`
          : message,
      );
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [path, enabled, optional]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer = 0;

    /**
     * Self-rescheduling timeout rather than setInterval.
     *
     * setInterval fires on a fixed cadence regardless of how long a request
     * takes, so a slow or failing API accumulates overlapping in-flight polls.
     * Chaining the next tick only after the previous one settles keeps at most
     * one request per resource outstanding, and lets the backoff multiplier
     * actually take effect.
     */
    const tick = async (): Promise<void> => {
      await load();
      if (cancelled) return;

      // An idle background tab should not keep the API busy.
      const base =
        document.visibilityState === "hidden"
          ? Math.max(30_000, intervalMs)
          : intervalMs;

      timer = window.setTimeout(() => void tick(), base * backoff.current);
    };

    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load, intervalMs, enabled]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { data, loading, error, updatedAt, refresh };
}
