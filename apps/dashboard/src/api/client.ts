// The pure resolution logic lives in ./resolve-base-url so it can be
// unit-tested without pulling browser globals into the Node test program.
export { resolveApiBaseUrl, type LocationLike } from "./resolve-base-url";
import { resolveApiBaseUrl } from "./resolve-base-url";

const configuredBase = import.meta.env.VITE_API_URL?.trim();

/**
 * Origin-only base. The `api` object below already spells out `/api/...` in
 * every path, so appending `/api` here would produce `/api/api/status`.
 * `resolveApiBaseUrl` is the tested, `/api`-suffixed form; this strips that
 * suffix rather than duplicating the resolution logic.
 */
export const API_BASE = resolveApiBaseUrl(
  configuredBase,
  typeof window === "undefined" ? undefined : window.location,
).replace(/\/api$/, "");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: string[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Bearer token for the API.
 *
 * Every route now requires authentication, including the read-only ones —
 * they disclose wallet balance, open positions and the risk configuration.
 * Without this header the dashboard reports the API as offline, because a
 * 401 is indistinguishable from a dead server at the panel level.
 *
 * Note this is a build-time value: Vite inlines `import.meta.env.*`, so the
 * dev server must be restarted after changing it.
 *
 * A token in a browser bundle is readable by anyone who can load the page.
 * That is acceptable only because the API binds loopback and the dashboard
 * is served on a trusted network — it is not a substitute for an
 * authenticating proxy if this is ever exposed.
 */
const API_TOKEN = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? "";

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
        ...(options.headers ?? {}),
      },
    });

    const text = await response.text();

    let data: unknown = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const message =
        typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : typeof data === "string" && data.trim()
            ? data
            : response.statusText || `API ${response.status}`;

      const details =
        typeof data === "object" &&
        data !== null &&
        "details" in data &&
        Array.isArray((data as { details?: unknown }).details)
          ? ((data as { details: unknown[] }).details.filter(
              (d): d is string => typeof d === "string",
            ) as string[])
          : undefined;

      throw new ApiError(response.status, message, details);
    }

    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(408, "Request timed out");
    }

    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const api = {
  getStatus: () => request<unknown>("/api/status"),

  getTokens: () => request<unknown>("/api/tokens"),

  clearTokens: () =>
    request<{ ok: boolean; cleared: number }>("/api/tokens/clear", {
      method: "POST",
    }),

  getPositions: () => request<unknown>("/api/positions"),

  getTrades: () => request<unknown>("/api/trades"),

  getBalance: () => request<unknown>("/api/balance"),

  getConfig: () => request<unknown>("/api/config"),

  updateConfig: (config: Record<string, number>) =>
    request<import("../types/api").ConfigSaveResult>("/api/config", {
      method: "POST",
      body: JSON.stringify(config),
    }),

  getTelemetry: () => request<unknown>("/api/telemetry"),
    getRejections: () => request<unknown>('/api/rejections'),

  startBot: () => request<unknown>("/api/start", { method: "POST" }),

  pauseBot: () => request<unknown>("/api/pause", { method: "POST" }),

  emergencyStop: () =>
    request<unknown>("/api/emergency-stop", {
      method: "POST",
    }),

  closePosition: (positionId: string) =>
    request<unknown>(
      `/api/positions/${encodeURIComponent(positionId)}/close`,
      {
        method: "POST",
      },
    ),
};