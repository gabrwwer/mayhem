// Dashboard API helpers.

export interface ApiLocation {
  origin?: string;
  hostname?: string;
  port?: string;
  protocol?: string;
}

export type ApiFetchOptions = RequestInit;

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function withApiSuffix(value: string): string {
  const base = value.trim().replace(/\/+$/, "");

  return base.endsWith("/api") ? base : `${base}/api`;
}

/**
 * API base rules:
 * - VITE_API_URL wins when configured.
 * - Localhost frontends use localhost:3001.
 * - Deployed frontend uses its current origin.
 * - Returned URL always ends in exactly one "/api".
 */
export function resolveApiBaseUrl(
  configured?: string,
  location?: ApiLocation,
): string {
  if (configured?.trim()) {
    return withApiSuffix(configured);
  }

  const isLocal =
    location?.hostname === "localhost" ||
    location?.hostname === "127.0.0.1" ||
    location?.hostname === "::1";

  if (isLocal) {
    return "http://localhost:3001/api";
  }

  if (location?.origin) {
    return withApiSuffix(location.origin);
  }

  return "http://localhost:3001/api";
}

const browserLocation: ApiLocation | undefined =
  typeof window !== "undefined"
    ? {
        origin: window.location.origin,
        hostname: window.location.hostname,
        port: window.location.port,
        protocol: window.location.protocol,
      }
    : undefined;

export const API_BASE = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL,
  browserLocation,
);

type ApiErrorBody = {
  error?: unknown;
  message?: unknown;
};

function getErrorMessage(
  status: number,
  statusText: string,
  data: unknown,
): string {
  if (typeof data === "object" && data !== null) {
    const body = data as ApiErrorBody;

    if (typeof body.error === "string") {
      return `API ${status}: ${body.error}`;
    }

    if (typeof body.message === "string") {
      return `API ${status}: ${body.message}`;
    }
  }

  if (typeof data === "string" && data.trim()) {
    return `API ${status}: ${data}`;
  }

  return `API ${status}: ${statusText || "Request failed"}`;
}

/**
 * API_BASE already has "/api".
 *
 * Correct:
 * apiFetch("/status")
 * apiFetch("/positions")
 * apiFetch("/orders")
 *
 * Incorrect:
 * apiFetch("/api/orders")
 */
/**
 * Bearer token for the API.
 *
 * The API now requires authentication on every route, including the
 * read-only ones — they disclose wallet balance, open positions and the
 * full risk configuration. Without VITE_API_TOKEN set at build time every
 * request returns 401.
 *
 * Note the trade-off being made here: a token in a browser bundle is
 * readable by anyone who can load the page, so this is only appropriate
 * for a dashboard served on a trusted network (which is also why the API
 * binds loopback by default). Do not expose this dashboard publicly on the
 * strength of this token alone — put a real authenticating proxy in front.
 */
const API_TOKEN = (import.meta.env?.["VITE_API_TOKEN"] as string | undefined) ?? "";

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const response = await fetch(`${API_BASE}${normalizedPath}`, {
    ...options,
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
    throw new ApiError(
      response.status,
      getErrorMessage(response.status, response.statusText, data),
    );
  }

  return data as T;
}