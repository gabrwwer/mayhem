
import type {
  BotConfig,
  BotState,
  Candle,
  Order,
  OrderBook,
  OrderRequest,
  Position,
  Ticker,
} from '../app/type';

const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body?.message) message = body.message;
      } catch {
        /* non-JSON error body â€” keep status text */
      }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiError(408, `Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  // --- market data ---
  getTicker: (coin: string) =>
    request<Ticker>(`/ticker?coin=${encodeURIComponent(coin)}`),
  getOrderBook: (coin: string, depth = 20) =>
    request<OrderBook>(
      `/orderbook?coin=${encodeURIComponent(coin)}&depth=${depth}`
    ),
  getCandles: (coin: string, interval = '1m', limit = 120) =>
    request<Candle[]>(
      `/candles?coin=${encodeURIComponent(coin)}&interval=${interval}&limit=${limit}`
    ),

  // --- trading ---
  getPositions: () => request<Position[]>('/positions'),
  getOpenOrders: () => request<Order[]>('/orders'),
  placeOrder: (order: OrderRequest) =>
    request<{ id: string }>('/orders', {
      method: 'POST',
      body: JSON.stringify(order),
    }),
  cancelOrder: (id: string) =>
    request<void>(`/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- bot ---
  getBotConfig: () => request<BotConfig>('/bot/config'),
  setBotConfig: (patch: Partial<BotConfig>) =>
    request<BotConfig>('/bot/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  getBotState: () => request<BotState>('/bot/state'),
  startBot: () => request<BotState>('/bot/start', { method: 'POST' }),
  stopBot: () => request<BotState>('/bot/stop', { method: 'POST' }),
  panic: () => request<{ closed: number }>('/bot/panic', { method: 'POST' }),
};