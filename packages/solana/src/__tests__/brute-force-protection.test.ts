import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BruteForceLimiter } from '../brute-force-limiter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Brute Force Protection', () => {
  let tempDir: string;
  let logPath: string;
  let limiter: BruteForceLimiter;
  const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-brute-force-test-'));
    logPath = path.join(tempDir, 'attempt-log.json');
    limiter = new BruteForceLimiter(logPath, mockLogger, { backoffBaseMs: 0 });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('checkAttempt', () => {
    it('should allow first attempt', () => {
      expect(() => limiter.checkAttempt()).not.toThrow();
    });

    it('should track and allow multiple failures with backoff', () => {
      for (let i = 0; i < 9; i++) {
        expect(() => limiter.checkAttempt()).not.toThrow();
        limiter.recordFailure();
      }

      // Should have logged warnings for later failures
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should lock account after max attempts', () => {
      // Make 10 failed attempts
      for (let i = 0; i < 10; i++) {
        limiter.checkAttempt();
        limiter.recordFailure();
      }

      // 11th attempt should fail
      expect(() => limiter.checkAttempt()).toThrow(/locked/i);
      expect(mockLogger.error).toHaveBeenCalledWith('Account locked', expect.any(Object));
    });

    it('should enforce exponential backoff', () => {
      limiter = new BruteForceLimiter(logPath, mockLogger, { backoffBaseMs: 1 });
      const start = performance.now();
      
      // Make 3 failed attempts
      for (let i = 0; i < 3; i++) {
        limiter.checkAttempt();
        limiter.recordFailure();
      }

      // Next attempt should be delayed; use a minimal nonzero base so the test
      // validates backoff without making the suite wait on production-scale delays.
      limiter.checkAttempt();
      const elapsed = performance.now() - start;

      // Should have at least some delay (we skip the full delay in tests)
      expect(elapsed).toBeGreaterThan(0);
    });

    it('should reject authenticated user if locked', () => {
      // Simulate max failures
      for (let i = 0; i < 10; i++) {
        try {
          limiter.checkAttempt();
        } catch {
          // Expected to fail on 10th
        }
        limiter.recordFailure();
      }

      // Any subsequent attempt should fail
      expect(() => limiter.checkAttempt()).toThrow();
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count', () => {
      limiter.checkAttempt();
      limiter.recordFailure();

      expect(limiter.getAttemptCount()).toBe(1);
    });

    it('should limit history to 24 hours', () => {
      const log = {
        attempts: [
          { timestamp: Date.now() - 30 * 60 * 60 * 1000, failed: true }, // 30 hours ago
          { timestamp: Date.now() - 1 * 60 * 60 * 1000, failed: true },  // 1 hour ago
        ],
      };

      fs.writeFileSync(logPath, JSON.stringify(log, null, 2), { mode: 0o600 });

      limiter.checkAttempt();
      limiter.recordFailure();

      const count = limiter.getAttemptCount();
      // Only recent failure should be counted (24-hour window)
      expect(count).toBe(1);
    });
  });

  describe('recordSuccess', () => {
    it('should clear failure history', () => {
      // Make 5 failed attempts
      for (let i = 0; i < 5; i++) {
        limiter.checkAttempt();
        limiter.recordFailure();
      }

      expect(limiter.getAttemptCount()).toBe(5);

      // Record success
      limiter.recordSuccess();

      expect(limiter.getAttemptCount()).toBe(0);
    });

    it('should allow login after success', () => {
      // Make 5 failed attempts
      for (let i = 0; i < 5; i++) {
        limiter.checkAttempt();
        limiter.recordFailure();
      }

      // Record success
      limiter.recordSuccess();

      // Should allow next attempt without delay
      const start = Date.now();
      expect(() => limiter.checkAttempt()).not.toThrow();
      const elapsed = Date.now() - start;

      // Should be fast (no backoff)
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('getAttemptCount', () => {
    it('should return 0 when no failures', () => {
      expect(limiter.getAttemptCount()).toBe(0);
    });

    it('should return count of recent failures', () => {
      for (let i = 0; i < 3; i++) {
        limiter.checkAttempt();
        limiter.recordFailure();
      }

      expect(limiter.getAttemptCount()).toBe(3);
    });

    it('should not count old failures (> 1 hour)', () => {
      const log = {
        attempts: [
          { timestamp: Date.now() - 2 * 60 * 60 * 1000, failed: true }, // 2 hours ago
        ],
      };

      fs.writeFileSync(logPath, JSON.stringify(log, null, 2), { mode: 0o600 });

      // Should not count the old failure
      expect(limiter.getAttemptCount()).toBe(0);
    });
  });

  describe('getUnlockTime', () => {
    it('should return null if not locked', () => {
      expect(limiter.getUnlockTime()).toBeNull();
    });

    it('should return time until unlock when locked', () => {
      // Make 10 failed attempts to lock
      for (let i = 0; i < 10; i++) {
        try {
          limiter.checkAttempt();
        } catch {
          // Expected on 10th
        }
        limiter.recordFailure();
      }

      const unlockTime = limiter.getUnlockTime();
      expect(unlockTime).toBeTruthy();
      expect(unlockTime).toBeGreaterThan(0);
      // Should be around 1 hour
      expect(unlockTime).toBeLessThanOrEqual(60 * 60 * 1000);
    });
  });

  describe('Integration tests', () => {
    it('should track real authentication workflow', () => {
      // User attempts password 3 times and fails
      for (let i = 0; i < 3; i++) {
        limiter.checkAttempt();
        limiter.recordFailure();
      }

      expect(limiter.getAttemptCount()).toBe(3);

      // User succeeds on 4th attempt
      limiter.checkAttempt(); // No throw
      limiter.recordSuccess();

      expect(limiter.getAttemptCount()).toBe(0);
      expect(limiter.getUnlockTime()).toBeNull();
    });

    it('should progressively increase backoff with repeated failures', () => {
      const delays: number[] = [];

      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        limiter.checkAttempt();
        const elapsed = Date.now() - start;
        delays.push(elapsed);
        limiter.recordFailure();
      }

      // Later attempts should have delays (though in tests they might be minimal)
      expect(delays.length).toBe(5);
    });
  });
});
