import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Authentication for the bot -> API internal channel.
 *
 * `/internal/tokens` and `/internal/telemetry` were unauthenticated and the
 * server bound 0.0.0.0, so anyone who could reach the port could inject
 * arbitrary token discoveries and telemetry into the operator's dashboard —
 * i.e. fabricate the evidence a human uses to decide whether to intervene.
 *
 * A shared secret + HMAC over the raw body is used rather than a bearer
 * token so a replayed or truncated body is also rejected. The timestamp
 * window bounds replay.
 */

const DEFAULT_MAX_SKEW_MS = 30_000;

export const INTERNAL_SIGNATURE_HEADER = 'x-mayhem-signature';
export const INTERNAL_TIMESTAMP_HEADER = 'x-mayhem-timestamp';

export function signInternalPayload(
  secret: string,
  timestamp: number,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

export interface InternalAuthOptions {
  secret: string;
  maxSkewMs?: number;
  now?: () => number;
}

export function createInternalAuth(options: InternalAuthOptions) {
  const { secret } = options;
  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const now = options.now ?? (() => Date.now());

  if (!secret) {
    throw new Error(
      'Internal auth requires INTERNAL_API_SECRET. Refusing to expose ' +
        '/internal routes without it.',
    );
  }

  return function internalAuth(
    req: Request & { rawBody?: string },
    res: Response,
    next: NextFunction,
  ): void {
    const signature = req.headers[INTERNAL_SIGNATURE_HEADER];
    const timestampHeader = req.headers[INTERNAL_TIMESTAMP_HEADER];

    if (typeof signature !== 'string' || typeof timestampHeader !== 'string') {
      res.status(401).json({ error: 'Missing internal signature' });
      return;
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
      res.status(401).json({ error: 'Invalid internal timestamp' });
      return;
    }

    if (Math.abs(now() - timestamp) > maxSkewMs) {
      res.status(401).json({ error: 'Internal request timestamp outside accepted window' });
      return;
    }

    // `rawBody` is captured by the express.json verify hook in index.ts.
    // Re-serialising req.body would not reproduce the bytes that were
    // signed (key order, number formatting), so the signature must be
    // computed over exactly what arrived.
    const rawBody = req.rawBody ?? '';
    const expected = signInternalPayload(secret, timestamp, rawBody);

    const provided = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    if (
      provided.length !== expectedBuf.length ||
      !timingSafeEqual(provided, expectedBuf)
    ) {
      res.status(401).json({ error: 'Invalid internal signature' });
      return;
    }

    next();
  };
}
