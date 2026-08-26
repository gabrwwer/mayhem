import * as fs from 'fs';

const BRUTE_FORCE_ATTEMPTS_MAX = 10;
const BRUTE_FORCE_LOCKOUT_MS = 60 * 60 * 1000; // 1 hour
const BRUTE_FORCE_BACKOFF_BASE_MS = 1000; // 1s

export interface AttemptRecord {
  timestamp: number;
  failed: boolean;
}

export interface AttemptLog {
  attempts: AttemptRecord[];
  lockedUntil?: number;
}

/**
 * Rate limiter for password authentication attempts.
 * Prevents brute-force attacks with exponential backoff and account lockout.
 */
export class BruteForceLimiter {
  private readonly backoffBaseMs: number;
  private cachedLog: AttemptLog | undefined;
  private cachedMtimeMs: number | undefined;

  constructor(
    private readonly logPath: string,
    private readonly logger?: { 
      warn: (msg: string, data?: any) => void;
      error: (msg: string, data?: any) => void;
    },
    options: { backoffBaseMs?: number } = {},
  ) {
    this.backoffBaseMs = Math.max(0, options.backoffBaseMs ?? BRUTE_FORCE_BACKOFF_BASE_MS);
  }

  private loadLog(): AttemptLog {
    if (!fs.existsSync(this.logPath)) {
      this.cachedLog = { attempts: [] };
      this.cachedMtimeMs = undefined;
      return this.cachedLog;
    }

    const mtimeMs = fs.statSync(this.logPath).mtimeMs;
    if (this.cachedLog && this.cachedMtimeMs === mtimeMs) {
      return this.cachedLog;
    }

    try {
      const content = fs.readFileSync(this.logPath, 'utf-8');
      this.cachedLog = JSON.parse(content);
      this.cachedMtimeMs = mtimeMs;
      return this.cachedLog!;
    } catch {
      this.cachedLog = { attempts: [] };
      this.cachedMtimeMs = mtimeMs;
      return this.cachedLog;
    }
  }

  private saveLog(log: AttemptLog): void {
    fs.writeFileSync(this.logPath, JSON.stringify(log, null, 2), { mode: 0o600 });
    this.cachedLog = log;
    this.cachedMtimeMs = fs.statSync(this.logPath).mtimeMs;
  }

  /**
   * Check if authentication attempt is allowed
   * Throws if locked or enforces backoff
   */
  checkAttempt(): void {
    const log = this.loadLog();
    const now = Date.now();

    // Check if locked
    const recentFailures = log.attempts.filter(
      (a) => a.failed && now - a.timestamp < BRUTE_FORCE_LOCKOUT_MS,
    ).length;

    if (recentFailures >= BRUTE_FORCE_ATTEMPTS_MAX) {
      const lockedUntil = Math.max(
        ...log.attempts
          .filter((a) => a.failed)
          .map((a) => a.timestamp + BRUTE_FORCE_LOCKOUT_MS),
      );

      const lockoutMinutes = Math.ceil((lockedUntil - now) / 60_000);
      const message =
        `Wallet locked due to too many failed attempts. ` +
        `Try again in ${lockoutMinutes} minutes after ${new Date(lockedUntil).toISOString()}`;

      this.logger?.error('Account locked', { lockedUntil, lockoutMinutes });
      throw new Error(message);
    }

    // Enforce exponential backoff
    if (recentFailures > 0) {
      const backoffMs = Math.min(
        this.backoffBaseMs * Math.pow(2, recentFailures - 1),
        30_000,
      );

      // Synchronous delay using busy-wait
      const deadline = Date.now() + backoffMs;
      while (Date.now() < deadline) {
        // Busy wait
      }

      if (recentFailures >= BRUTE_FORCE_ATTEMPTS_MAX - 3) {
        this.logger?.warn('Multiple failed authentication attempts', {
          failureCount: recentFailures,
          backoffMs,
        });
      }
    }
  }

  /**
   * Record a failed authentication attempt
   */
  recordFailure(): void {
    const log = this.loadLog();
    const now = Date.now();

    log.attempts.push({
      timestamp: now,
      failed: true,
    });

    // Keep only last 24 hours of attempts
    log.attempts = log.attempts.filter(
      (a) => now - a.timestamp < 24 * 60 * 60 * 1000,
    );

    this.saveLog(log);
  }

  /**
   * Record a successful authentication attempt (clears attempt history)
   */
  recordSuccess(): void {
    const log: AttemptLog = { attempts: [] };
    this.saveLog(log);
  }

  /**
   * Get current attempt count
   */
  getAttemptCount(): number {
    const log = this.loadLog();
    const now = Date.now();

    return log.attempts.filter(
      (a) => a.failed && now - a.timestamp < BRUTE_FORCE_LOCKOUT_MS,
    ).length;
  }

  /**
   * Get time until account is unlocked (null if not locked)
   */
  getUnlockTime(): number | null {
    const log = this.loadLog();
    const now = Date.now();

    const recentFailures = log.attempts.filter(
      (a) => a.failed && now - a.timestamp < BRUTE_FORCE_LOCKOUT_MS,
    ).length;

    if (recentFailures < BRUTE_FORCE_ATTEMPTS_MAX) {
      return null; // Not locked
    }

    const lockedUntil = Math.max(
      ...log.attempts
        .filter((a) => a.failed)
        .map((a) => a.timestamp + BRUTE_FORCE_LOCKOUT_MS),
    );

    return Math.max(0, lockedUntil - now);
  }
}
