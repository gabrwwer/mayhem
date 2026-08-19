import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * API authentication.
 *
 * This file previously exported `(req, res, next) => next()` — a no-op that
 * authenticated nothing — while `index.ts` carried a second, real
 * implementation. Two auth functions with the same name is a loaded gun:
 * one wrong import and every mutating endpoint, including the kill switch,
 * becomes public. There is now exactly one implementation, here.
 */

export interface AuthOptions {
  /** Accepted bearer tokens. Empty means "no credentials configured". */
  tokens: string[];
}

/**
 * Tokens are compared as fixed-length SHA-256 digests.
 *
 * `Array.includes` on the raw strings leaks token length and prefix through
 * timing, and `timingSafeEqual` throws on length mismatch — hashing first
 * gives constant-length inputs and a constant-time compare.
 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function matches(provided: string, expected: Buffer[]): boolean {
  const providedDigest = digest(provided);
  let found = false;
  // Compare against every candidate — no early exit, so the time taken does
  // not reveal which token (if any) matched.
  for (const candidate of expected) {
    if (timingSafeEqual(providedDigest, candidate)) {
      found = true;
    }
  }
  return found;
}

export function createAuthMiddleware(options: AuthOptions) {
  const expected = options.tokens.map(digest);

  return function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // No credentials configured is ALWAYS a refusal, in every environment.
    //
    // The previous logic called `next()` in non-production, and offered an
    // `API_AUTH_DISABLED=true` escape hatch that bypassed the production
    // check too. "Development" is not a security boundary — a dev machine
    // on a shared network exposed the same portfolio data and kill switch.
    if (expected.length === 0) {
      res.status(503).json({
        error:
          'API authentication is not configured. Set API_AUTH_TOKEN or API_KEYS.',
      });
      return;
    }

    const authorization = req.headers.authorization;
    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : undefined;

    if (!provided || !matches(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
