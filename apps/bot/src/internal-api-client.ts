import { createHmac } from 'node:crypto';
import { logger } from './logger';

/**
 * Signed client for the bot -> API internal channel.
 *
 * The `/internal/*` routes render straight into the operator dashboard, so
 * an unauthenticated channel let anyone who could reach the port fabricate
 * the information a human uses to decide whether to intervene. Requests are
 * HMAC-signed over the exact request body plus a timestamp; the API rejects
 * anything outside a 30s window, which bounds replay.
 */

export interface InternalApiClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export class InternalApiClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  /** Suppresses repeat "API is down" warnings; see post(). */
  private unreachableCount = 0;

  constructor(options: InternalApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Best-effort POST. Dashboard sync must never block or fail the trading
   * path, so errors are logged and swallowed — but they ARE logged, because
   * a silently dead telemetry channel means the operator is flying blind
   * without knowing it.
   */
  async post(path: string, payload: unknown): Promise<void> {
    if (!this.secret) {
      logger.warn('INTERNAL_API_UNSIGNED_SKIPPED', {
        path,
        note: 'INTERNAL_API_SECRET not configured; refusing to send unsigned',
      });
      return;
    }

    if (typeof globalThis.fetch !== 'function') return;

    const body = JSON.stringify(payload);
    const timestamp = Date.now();
    const signature = createHmac('sha256', this.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    try {
      const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mayhem-timestamp': String(timestamp),
          'x-mayhem-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        logger.warn('INTERNAL_API_REJECTED', { path, status: res.status });
      }
    } catch (err) {
      /*
       * Log the first failure, then go quiet.
       *
       * This fires on every discovery and every rejection. With the API not
       * running it produced roughly half of all log lines, burying the
       * entries, rejections and prices that actually matter. A dashboard
       * feed that is down is one fact, not one fact per event.
       */
      this.unreachableCount += 1;
      if (this.unreachableCount === 1) {
        logger.warn('INTERNAL_API_UNREACHABLE', {
          path,
          error: err instanceof Error ? err.message : String(err),
          note: 'dashboard feed only; trading is unaffected. Further failures suppressed.',
        });
      } else if (this.unreachableCount % 500 === 0) {
        logger.warn('INTERNAL_API_UNREACHABLE', {
          suppressed: this.unreachableCount,
          note: 'dashboard feed still down; trading unaffected',
        });
      }
    }
  }
}
