import type { Request, Response, NextFunction } from 'express';

/**
 * Fixed-window rate limiter.
 *
 * This file previously exported a no-op, so `RATE_LIMIT_WINDOW_MS` and
 * `RATE_LIMIT_MAX` were configured but never enforced — leaving the auth
 * endpoints open to unlimited token guessing and the RPC-backed routes
 * (`/api/balance` hits Solana) open to trivial amplification.
 *
 * In-process only, which is correct for a single-instance bot API. Behind
 * more than one replica this must move to Redis, or each replica will allow
 * the full quota independently.
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Bucket key. Defaults to the socket address. */
  keyFor?: (req: Request) => string;
  now?: () => number;
}

/**
 * Each call to `createRateLimit` owns a private bucket map, so two limiters
 * never share a counter even when they see the same source address.
 *
 * This matters on localhost, where the bot and the dashboard are both
 * 127.0.0.1. With one shared limiter the bot's token-discovery firehose on
 * /internal/* consumed the quota and starved the operator's dashboard — the
 * UI reported "API OFFLINE" while the API was perfectly healthy. A control
 * that hides the state of a trading system from its operator is worse than no
 * control, so the two traffic classes are now limited independently.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimit(options: RateLimitOptions) {
  const { windowMs, max } = options;
  const now = options.now ?? (() => Date.now());
  const keyFor =
    options.keyFor ?? ((req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown');

  const buckets = new Map<string, Bucket>();

  // Bound memory: a stream of unique source addresses would otherwise grow
  // the map without limit, turning the rate limiter into the DoS vector.
  const sweep = (currentTime: number): void => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(key);
    }
  };

  let lastSweep = now();

  return function rateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const currentTime = now();

    if (currentTime - lastSweep > windowMs) {
      sweep(currentTime);
      lastSweep = currentTime;
    }

    const key = keyFor(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= currentTime) {
      buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
      next();
      return;
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - currentTime) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfterSec, 1)));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };
}
