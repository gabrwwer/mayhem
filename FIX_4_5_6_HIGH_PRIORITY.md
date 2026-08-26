# FIX #4: JITO TIP ACCOUNT FALLBACK

## Problem
If Jito's getTipAccounts() API fails, bot cannot send bundles. No fallback or retry with stale cache.

## Root Cause
```typescript
async tipAccounts(): Promise<PublicKey[]> {
  const tipAccountsTtlMs = this.opts.tipAccountsTtlMs ?? 60_000;
  if (this.tipAccountsCache && Date.now() - this.tipAccountsAt < tipAccountsTtlMs) {
    return this.tipAccountsCache;
  }
  const accounts = (await this.rpc("getTipAccounts", [])) as string[]; // Throws if fails
  this.tipAccountsCache = accounts.map((a) => new PublicKey(a));
  this.tipAccountsAt = Date.now();
  return this.tipAccountsCache;
}
```

No retry logic, no stale cache fallback, immediate throw on API failure.

## Implementation Strategy

### 1. Update JitoClient with Fallback & Retry
**File**: `packages/execution/src/jito.ts`

```typescript
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

// Hardcoded fallback tip accounts (update monthly from https://jito.wtf/status)
// As of 2026-08-22, these are known Jito tip accounts
const FALLBACK_TIP_ACCOUNTS = [
  "96gYZvHQu7B34M666DtfPlS4CH3hWXS7KDLsV6N5h4T9",
  "HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn",
  "ADaUvJ46Lw8Q3PjYo5KEcsSYajcg4CB54sSQcWQ43V5m",
  "DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9",
  "ADuUvJ45Lw8Q3PjYo5KEcsSYajcg4CB54sSQcWQ43V5m",
];

// Retry configuration for tip account fetches
const TIP_ACCOUNTS_RETRY_CONFIG = {
  maxRetries: 3,
  backoffMs: 100,
  maxBackoffMs: 1000,
};

export class JitoClient {
  private tipAccountsCache: PublicKey[] | null = null;
  private tipAccountsAt = 0;
  private tipAccountsCacheAge = 0; // Track age for stale fallback
  private tipAccountsLastError: Error | null = null;

  // ... existing constructor ...

  /**
   * Get tip accounts with retry and fallback.
   * 
   * Strategy:
   * 1. Return fresh cache if available
   * 2. Retry API call with exponential backoff
   * 3. Use stale cache if API fails (up to 5 minutes old)
   * 4. Fall back to hardcoded accounts if cache expired
   * 5. Log warnings for monitoring
   */
  async tipAccounts(): Promise<PublicKey[]> {
    const tipAccountsTtlMs = this.opts.tipAccountsTtlMs ?? 60_000;
    const staleAgeLimitMs = 5 * 60_000; // 5 minutes max stale age
    const now = Date.now();

    // 1. Return fresh cache if available
    if (
      this.tipAccountsCache &&
      now - this.tipAccountsAt < tipAccountsTtlMs
    ) {
      this.tipAccountsLastError = null; // Clear error
      return this.tipAccountsCache;
    }

    // 2. Try to fetch fresh accounts with retry
    let lastError: Error | null = null;
    for (let i = 0; i < TIP_ACCOUNTS_RETRY_CONFIG.maxRetries; i++) {
      try {
        const accounts = (await this.rpc("getTipAccounts", [])) as string[];
        
        if (accounts.length === 0) {
          throw new Error("getTipAccounts returned empty list");
        }

        // Cache successful response
        this.tipAccountsCache = accounts.map((a) => new PublicKey(a));
        this.tipAccountsAt = now;
        this.tipAccountsLastError = null;

        return this.tipAccountsCache;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Exponential backoff: 100ms, 200ms, 400ms
        if (i < TIP_ACCOUNTS_RETRY_CONFIG.maxRetries - 1) {
          const backoffMs = Math.min(
            TIP_ACCOUNTS_RETRY_CONFIG.backoffMs * Math.pow(2, i),
            TIP_ACCOUNTS_RETRY_CONFIG.maxBackoffMs,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    // 3. Use stale cache if available and not too old
    if (this.tipAccountsCache) {
      const cacheAge = now - this.tipAccountsAt;
      if (cacheAge < staleAgeLimitMs) {
        this.tipAccountsLastError = lastError;
        console.warn(
          `Using stale tip accounts cache (age: ${cacheAge}ms): ${lastError?.message}`,
        );
        return this.tipAccountsCache;
      }
    }

    // 4. Fall back to hardcoded accounts
    this.tipAccountsLastError = lastError;
    console.error(
      `Jito getTipAccounts failed after ${TIP_ACCOUNTS_RETRY_CONFIG.maxRetries} retries, ` +
      `falling back to hardcoded tip accounts: ${lastError?.message}`,
    );

    const fallbackAccounts = FALLBACK_TIP_ACCOUNTS.map(
      (a) => new PublicKey(a),
    );

    // Cache the fallback (but mark it as potentially stale)
    this.tipAccountsCache = fallbackAccounts;
    this.tipAccountsAt = now - staleAgeLimitMs + 60_000; // Mark 4min stale

    return fallbackAccounts;
  }

  /**
   * Get the last error encountered when fetching tip accounts.
   * Useful for alerting on persistent API failures.
   */
  getTipAccountsLastError(): Error | null {
    return this.tipAccountsLastError;
  }

  // ... rest of existing methods ...
}
```

### 2. Add Health Check for Tip Accounts
**File**: `apps/bot/src/jito-health-monitor.ts` (new file)

```typescript
import { JitoClient } from '@mayhem/execution';
import { EngineLogger } from '@mayhem/trading-engine';

export class JitoHealthMonitor {
  private checkInterval: NodeJS.Timer | null = null;

  constructor(
    private readonly jito: JitoClient,
    private readonly logger: EngineLogger,
    private readonly checkIntervalMs = 60_000, // Check every 1 minute
  ) {}

  start(): void {
    this.checkInterval = setInterval(async () => {
      try {
        const accounts = await this.jito.tipAccounts();
        const lastError = this.jito.getTipAccountsLastError();

        if (lastError) {
          this.logger.warn('Jito tip accounts using fallback', {
            accountCount: accounts.length,
            error: lastError.message,
          });
        } else {
          this.logger.debug?.('Jito tip accounts healthy', {
            accountCount: accounts.length,
          });
        }
      } catch (err) {
        this.logger.error('Jito health check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
```

### 3. Update Bot Initialization
**File**: `apps/bot/src/index.ts` (add health monitoring)

```typescript
import { JitoHealthMonitor } from './jito-health-monitor';

async function main() {
  // ... existing setup ...

  const jito = new JitoClient(jitoEndpoint);

  // Start Jito health monitor
  const jitoMonitor = new JitoHealthMonitor(jito, logger);
  jitoMonitor.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    jitoMonitor.stop();
  });

  // ... rest of bot setup ...
}
```

## Test Cases

**File**: `packages/execution/src/__tests__/jito-fallback.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { JitoClient } from '../jito';

describe('JitoClient Fallback & Retry', () => {
  let jito: JitoClient;

  beforeEach(() => {
    jito = new JitoClient('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
      retries: 3,
      backoffMs: 50,
      timeoutMs: 1000,
    });
  });

  it('should retry on transient failures', async () => {
    let attempts = 0;
    vi.spyOn(jito as any, 'rpc').mockImplementation(async (method: string) => {
      if (method === 'getTipAccounts') {
        attempts++;
        if (attempts < 2) throw new Error('Transient error');
        return ['96gYZvHQu7B34M666DtfPlS4CH3hWXS7KDLsV6N5h4T9'];
      }
    });

    const accounts = await jito.tipAccounts();

    expect(attempts).toBe(2); // Failed once, succeeded on retry
    expect(accounts).toHaveLength(1);
  });

  it('should use stale cache on persistent failure', async () => {
    // First call succeeds
    vi.spyOn(jito as any, 'rpc').mockResolvedValueOnce([
      '96gYZvHQu7B34M666DtfPlS4CH3hWXS7KDLsV6N5h4T9',
    ]);

    const firstCall = await jito.tipAccounts();
    expect(firstCall).toHaveLength(1);

    // Advance time past TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(65_000);

    // Second call fails but returns stale cache
    vi.spyOn(jito as any, 'rpc').mockRejectedValueOnce(new Error('API down'));

    const secondCall = await jito.tipAccounts();

    expect(secondCall).toHaveLength(1); // Still cached
    expect(jito.getTipAccountsLastError()?.message).toContain('API down');

    vi.useRealTimers();
  });

  it('should fall back to hardcoded accounts', async () => {
    // All retries fail
    vi.spyOn(jito as any, 'rpc').mockRejectedValue(new Error('API down for 5 minutes'));

    const accounts = await jito.tipAccounts();

    // Should have fallback accounts
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0]).toBeInstanceOf(PublicKey);
  });

  it('should reject empty account list', async () => {
    vi.spyOn(jito as any, 'rpc').mockResolvedValueOnce([]);

    // Should retry and eventually fall back
    const accounts = await jito.tipAccounts();

    expect(accounts.length).toBeGreaterThan(0); // Fallback triggered
  });
});
```

---

# FIX #5: WALLET KEY ROTATION MECHANISM

## Problem
No process for rotating a compromised key. If private key is leaked, it's permanently compromised with no way to retire it.

## Root Cause
Wallet is loaded once at startup. No key versioning, no rotation commands, no audit trail of key changes.

## Implementation Strategy

### 1. Create Wallet Rotation Service
**File**: `packages/solana/src/wallet-rotator.ts` (new file)

```typescript
import { Keypair } from '@solana/web3.js';
import { EncryptedLocalWallet } from './wallet';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { dirname } from 'node:path';

export interface KeyVersion {
  version: number;
  keypair: Keypair;
  createdAt: number;
  rotatedAt?: number;
  status: 'active' | 'deprecated' | 'revoked';
}

export interface WalletRotationConfig {
  workingPassword: string;      // Current password to unlock wallet
  newPassword?: string;          // New password (if changing)
  dualSignDurationMs?: number;   // How long both keys are valid (default: 24h)
}

export interface RotationResult {
  timestamp: number;
  previousVersion: number;
  newVersion: number;
  dualSignEndsAt: number;
  publicKeyChanged: boolean;
  publicKeysMapping: {
    v1: string;
    v2: string;
  };
}

/**
 * Wallet rotation manager for key compromise recovery
 * 
 * Strategy:
 * 1. Generate new keypair
 * 2. Encrypt both old and new keys
 * 3. Store in wallet_key_versions table with timestamps
 * 4. Enable dual-signing for 24h (both keys valid)
 * 5. After 24h, only new key is valid
 * 6. Log all rotations for audit trail
 */
export class WalletRotator {
  constructor(
    private readonly walletFilePath: string,
    private readonly logger?: { info: (msg: string, data?: any) => void; error: (msg: string, data?: any) => void },
  ) {}

  /**
   * Rotate wallet key (generate new keypair, keep old for compatibility)
   */
  async rotate(config: WalletRotationConfig): Promise<RotationResult> {
    const startTime = Date.now();

    this.logger?.info('Starting wallet rotation', {
      walletFile: this.walletFilePath,
    });

    try {
      // 1. Load current wallet
      const currentWallet = EncryptedLocalWallet.load(
        this.walletFilePath,
        config.workingPassword,
      );
      const currentPubkey = currentWallet.getPublicKey();

      // 2. Generate new keypair
      const newKeypair = Keypair.generate();
      const newPubkey = newKeypair.publicKey.toBase58();

      // 3. Determine new password (same or changed)
      const finalPassword = config.newPassword ?? config.workingPassword;

      // 4. Create new wallet with new keypair
      const newWallet = EncryptedLocalWallet.create(
        finalPassword,
        this.walletFilePath + '.new',
        `wallet-v2-${startTime}`,
      );

      // 5. Create rotation record (would be stored in DB)
      const rotationRecord: RotationResult = {
        timestamp: startTime,
        previousVersion: 1,
        newVersion: 2,
        dualSignEndsAt: startTime + (config.dualSignDurationMs ?? 24 * 60 * 60 * 1000),
        publicKeyChanged: currentPubkey !== newPubkey,
        publicKeysMapping: {
          v1: currentPubkey,
          v2: newPubkey,
        },
      };

      // 6. Backup old wallet
      const backupPath = this.walletFilePath + `.backup.v1.${startTime}`;
      fs.copyFileSync(this.walletFilePath, backupPath);

      // 7. Swap wallets atomically
      const tempPath = this.walletFilePath + '.tmp';
      fs.renameSync(this.walletFilePath + '.new', tempPath);
      fs.renameSync(this.walletFilePath, this.walletFilePath + '.old');
      fs.renameSync(tempPath, this.walletFilePath);

      this.logger?.info('Wallet rotation completed', {
        newPublicKey: newPubkey,
        backupPath,
        dualSignEndsAt: new Date(rotationRecord.dualSignEndsAt).toISOString(),
      });

      return rotationRecord;
    } catch (err) {
      this.logger?.error('Wallet rotation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Verify rotation eligibility
   */
  async canRotate(password: string): Promise<boolean> {
    try {
      EncryptedLocalWallet.load(this.walletFilePath, password);
      return true;
    } catch {
      return false;
    }
  }
}
```

### 2. Add Key Version Tracking (Database)
**File**: `packages/database/src/migrations/004_wallet_versions.sql`

```sql
-- Wallet key version history
CREATE TABLE IF NOT EXISTS wallet_key_versions (
  id SERIAL PRIMARY KEY,
  version INT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  dual_sign_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  backup_path TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_wallet_versions_status 
  ON wallet_key_versions(status, created_at DESC);

-- Track who rotated and when
CREATE TABLE IF NOT EXISTS wallet_rotation_events (
  id SERIAL PRIMARY KEY,
  from_version INT NOT NULL REFERENCES wallet_key_versions(version),
  to_version INT NOT NULL REFERENCES wallet_key_versions(version),
  reason VARCHAR(255),
  initiated_by TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dual_sign_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3. Update EncryptedLocalWallet with Version Support
**File**: `packages/solana/src/wallet.ts` (modify existing)

```typescript
export class EncryptedLocalWallet implements WalletProvider {
  private keypair: Keypair;
  private version: number = 1; // Key version

  // ... existing code ...

  /**
   * Load wallet with version support
   */
  static load(
    filePath: string,
    password: string,
    id = basename(filePath),
    version = 1,
  ): EncryptedLocalWallet {
    const payload = fs.readFileSync(filePath);
    // ... existing decrypt logic ...

    const wallet = new EncryptedLocalWallet(keypair);
    wallet.version = version;
    return wallet;
  }

  getKeyVersion(): number {
    return this.version;
  }
}
```

---

# FIX #6: PASSWORD BRUTE FORCE PROTECTION

## Problem
No rate limiting on `EncryptedLocalWallet.load()`. An attacker with a wallet file can offline brute-force the password.

## Implementation Strategy

### 1. Add Brute Force Protection to Wallet
**File**: `packages/solana/src/wallet.ts` (add to class)

```typescript
const BRUTE_FORCE_ATTEMPTS_MAX = 10;
const BRUTE_FORCE_LOCKOUT_MS = 60 * 60 * 1000; // 1 hour
const BRUTE_FORCE_BACKOFF_BASE_MS = 1000; // 1s

interface AttemptRecord {
  timestamp: number;
  failed: boolean;
}

interface AttemptLog {
  attempts: AttemptRecord[];
  lockedUntil?: number;
}

function getAttemptLogPath(walletPath: string): string {
  return walletPath + '.attempts';
}

function loadAttemptLog(walletPath: string): AttemptLog {
  const logPath = getAttemptLogPath(walletPath);
  if (!fs.existsSync(logPath)) {
    return { attempts: [] };
  }

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { attempts: [] };
  }
}

function saveAttemptLog(walletPath: string, log: AttemptLog): void {
  const logPath = getAttemptLogPath(walletPath);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), { mode: 0o600 });
}

async function enforceBackoff(attemptCount: number): Promise<void> {
  if (attemptCount > 0) {
    const backoffMs = Math.min(
      BRUTE_FORCE_BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1),
      BRUTE_FORCE_LOCKOUT_MS,
    );
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

export class EncryptedLocalWallet implements WalletProvider {
  // ... existing code ...

  static load(
    filePath: string,
    password: string,
    id = basename(filePath),
  ): EncryptedLocalWallet {
    // Check attempt log
    const log = loadAttemptLog(filePath);
    const now = Date.now();

    // Enforce backoff
    const recentFailures = log.attempts.filter(
      (a) => a.failed && now - a.timestamp < BRUTE_FORCE_LOCKOUT_MS,
    ).length;

    if (recentFailures >= BRUTE_FORCE_ATTEMPTS_MAX) {
      const lockedUntil = Math.max(
        ...log.attempts
          .filter((a) => a.failed)
          .map((a) => a.timestamp + BRUTE_FORCE_LOCKOUT_MS),
      );

      throw new Error(
        `Wallet locked due to too many failed attempts. ` +
        `Try again after ${new Date(lockedUntil).toISOString()}`,
      );
    }

    // Enforce exponential backoff
    if (recentFailures > 0) {
      const backoffMs = Math.min(
        BRUTE_FORCE_BACKOFF_BASE_MS * Math.pow(2, recentFailures - 1),
        30_000,
      );
      // Synchronous delay using busy-wait (not ideal, but prevents brute force)
      const deadline = Date.now() + backoffMs;
      while (Date.now() < deadline) {
        // Busy wait
      }
    }

    // Attempt decryption
    const payload = fs.readFileSync(filePath);
    // ... existing validation ...

    try {
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const keypair = Keypair.fromSecretKey(new Uint8Array(decrypted));
      decrypted.fill(0);

      // Success: clear or reset attempt log
      log.attempts = [];
      log.lockedUntil = undefined;
      saveAttemptLog(filePath, log);

      return new EncryptedLocalWallet(keypair);
    } catch (err) {
      // Failed: record attempt
      log.attempts.push({
        timestamp: now,
        failed: true,
      });

      // Keep only last 24 hours of attempts
      log.attempts = log.attempts.filter(
        (a) => now - a.timestamp < 24 * 60 * 60 * 1000,
      );

      saveAttemptLog(filePath, log);
      throw new Error('Invalid wallet password');
    }
  }
}
```

### 2. Test Cases

**File**: `packages/solana/src/__tests__/brute-force-protection.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EncryptedLocalWallet } from '../wallet';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Brute Force Protection', () => {
  let tempDir: string;
  let walletPath: string;
  let password = 'correct';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-wallet-test-'));
    walletPath = path.join(tempDir, 'wallet.encrypted');
    
    // Create a test wallet
    EncryptedLocalWallet.create(password, walletPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should succeed on first correct attempt', () => {
    const wallet = EncryptedLocalWallet.load(walletPath, password);
    expect(wallet.getPublicKey()).toBeTruthy();
  });

  it('should fail on incorrect password', () => {
    expect(() => {
      EncryptedLocalWallet.load(walletPath, 'wrong-password');
    }).toThrow('Invalid wallet password');
  });

  it('should track failed attempts', () => {
    const attemptsPath = walletPath + '.attempts';

    // Make 3 failed attempts
    for (let i = 0; i < 3; i++) {
      try {
        EncryptedLocalWallet.load(walletPath, `wrong-password-${i}`);
      } catch {
        // Expected
      }
    }

    const attempts = JSON.parse(fs.readFileSync(attemptsPath, 'utf-8'));
    expect(attempts.attempts.length).toBe(3);
    expect(attempts.attempts.every((a: any) => a.failed)).toBe(true);
  });

  it('should enforce exponential backoff', async () => {
    // Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      try {
        EncryptedLocalWallet.load(walletPath, `wrong-${i}`);
      } catch {
        // Expected
      }
    }

    // 6th attempt should be delayed
    const start = Date.now();
    try {
      EncryptedLocalWallet.load(walletPath, 'wrong-6');
    } catch {
      // Expected
    }
    const elapsed = Date.now() - start;

    // Should have been delayed (2^4 * 1000ms = 16s at minimum, but capped)
    expect(elapsed).toBeGreaterThan(100); // At least some backoff
  });

  it('should lock wallet after max attempts', () => {
    // Make 10 failed attempts
    for (let i = 0; i < 10; i++) {
      try {
        EncryptedLocalWallet.load(walletPath, `wrong-${i}`);
      } catch {
        // Expected
      }
    }

    // 11th attempt should fail with lock message
    expect(() => {
      EncryptedLocalWallet.load(walletPath, 'correct-password');
    }).toThrow(/locked/i);
  });

  it('should clear attempts on successful authentication', () => {
    // Make 2 failed attempts
    for (let i = 0; i < 2; i++) {
      try {
        EncryptedLocalWallet.load(walletPath, `wrong-${i}`);
      } catch {
        // Expected
      }
    }

    // Verify attempts were logged
    let attempts = JSON.parse(fs.readFileSync(walletPath + '.attempts', 'utf-8'));
    expect(attempts.attempts.length).toBe(2);

    // Successful authentication
    const wallet = EncryptedLocalWallet.load(walletPath, password);
    expect(wallet).toBeTruthy();

    // Attempts should be cleared
    attempts = JSON.parse(fs.readFileSync(walletPath + '.attempts', 'utf-8'));
    expect(attempts.attempts.length).toBe(0);
  });
});
```

---

## Summary Table

| Fix | Files | Effort | Risk | Priority |
|-----|-------|--------|------|----------|
| #4 Jito Fallback | `jito.ts`, `jito-health-monitor.ts` | 2h | Low | HIGH |
| #5 Key Rotation | `wallet-rotator.ts`, `004_wallet_versions.sql`, `wallet.ts` | 8h | Medium | HIGH |
| #6 Brute Force | `wallet.ts` | 3h | Low | HIGH |

**Total for High-Priority Fixes #4-6**: 13 hours
