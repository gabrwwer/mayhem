
import type { WsMessage } from '../app/type';

export type WsStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'error';

type WsListener = (msg: WsMessage) => void;

interface WsOptions {
  url?: string;
  heartbeatMs?: number;
  maxRetries?: number;
  onStatusChange?: (status: WsStatus) => void;
}

const DEFAULTS = { heartbeatMs: 30_000, maxRetries: 10 } as const;

/**
 * Resilient WebSocket client: auto-reconnect with exponential backoff,
 * heartbeat keep-alive, per-listener error isolation and clean teardown.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<WsListener>();
  private retries = 0;
  private heartbeat: number | undefined;
  private manualClose = false;
  private status: WsStatus = 'idle';
  private readonly url: string;
  private readonly heartbeatMs: number;
  private readonly maxRetries: number;
  private readonly onStatusChange?: (status: WsStatus) => void;

  constructor(options: WsOptions = {}) {
    const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
    this.url =
      options.url ??
      fromEnv ??
      (() => {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        return `${proto}://${window.location.host}/ws`;
      })();
    this.heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.onStatusChange = options.onStatusChange;
  }

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.manualClose = false;
    this.setStatus(this.retries > 0 ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this.setStatus('open');
      this.startHeartbeat();
      this.send({ op: 'subscribe', channels: ['ticker', 'orderbook', 'trades', 'bot'] });
    };

    ws.onmessage = (ev) => this.handleMessage(ev);

    ws.onerror = () => {
      if (this.status !== 'reconnecting') this.setStatus('error');
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      if (this.manualClose) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleMessage(ev: MessageEvent): void {
    let parsed: WsMessage;
    try {
      parsed = JSON.parse(String(ev.data)) as WsMessage;
    } catch {
      return; // ignore malformed frames
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const listener of this.listeners) {
      try {
        listener(parsed);
      } catch {
        /* isolate listener errors so one bad subscriber can not kill the socket */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    if (this.retries >= this.maxRetries) {
      this.setStatus('error');
      return;
    }
    this.retries += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.retries, 6));
    this.setStatus('reconnecting');
    window.setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ op: 'ping' });
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    try {
      this.onStatusChange?.(status);
    } catch {
      /* status observers must never break the socket */
    }
  }

  send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  subscribe(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.manualClose = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  get currentStatus(): WsStatus {
    return this.status;
  }
}