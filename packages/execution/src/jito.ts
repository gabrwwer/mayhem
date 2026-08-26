
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Hardcoded fallback tip accounts (updated monthly from https://jito.wtf/status)
// As of 2026-08-22, these are known Jito tip accounts
const FALLBACK_TIP_ACCOUNTS = [
  "96gYZvHQu7B34M666DtfPlS4CH3hWXS7KDLsV6N5h4T9",
  "HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn",
  "ADaUvJ46Lw8Q3PjYo5KEcsSYajcg4CB54sSQcWQ43V5m",
  "DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9",
];

const TIP_ACCOUNTS_RETRY_CONFIG = {
  maxRetries: 3,
  backoffMs: 100,
  maxBackoffMs: 1000,
};

function parseValidTipAccounts(values: string[]): PublicKey[] {
  const accounts: PublicKey[] = [];
  for (const value of values) {
    try {
      accounts.push(new PublicKey(value));
    } catch {
      // Ignore malformed provider data and continue with validated accounts.
    }
  }
  return accounts;
}

export type BundleStatus = "Invalid" | "Pending" | "Landed";

interface InflightStatus {
  bundle_id: string;
  status: BundleStatus;
  transactions: string[];
}

export class JitoClient {
  private tipAccountsCache: PublicKey[] | null = null;
  private tipAccountsAt = 0;
  private tipAccountsLastError: Error | null = null;

  constructor(
    private readonly endpoint: string = BLOCK_ENGINE,
    private readonly opts: {
      retries?: number;
      backoffMs?: number;
      timeoutMs?: number;
      pollMs?: number;
      tipAccountsTtlMs?: number;
    } = {},
  ) {}

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
    const maxRetries = Math.max(1, this.opts.retries ?? TIP_ACCOUNTS_RETRY_CONFIG.maxRetries);
    const backoffMsBase = Math.max(0, this.opts.backoffMs ?? TIP_ACCOUNTS_RETRY_CONFIG.backoffMs);
    for (let i = 0; i < maxRetries; i++) {
      try {
        const accounts = (await this.rpc("getTipAccounts", [])) as string[];

        const validAccounts = parseValidTipAccounts(accounts);
        if (validAccounts.length === 0) {
          throw new Error("getTipAccounts returned empty list");
        }

        // Cache successful response
        this.tipAccountsCache = validAccounts;
        this.tipAccountsAt = now;
        this.tipAccountsLastError = null;

        return this.tipAccountsCache;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Exponential backoff: 100ms, 200ms, 400ms
        if (i < maxRetries - 1) {
          const backoffMs = Math.min(
            backoffMsBase * Math.pow(2, i),
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
      `Jito getTipAccounts failed after ${maxRetries} retries, ` +
      `falling back to hardcoded tip accounts: ${lastError?.message}`,
    );

    const fallbackAccounts = parseValidTipAccounts(FALLBACK_TIP_ACCOUNTS);
    if (fallbackAccounts.length === 0) {
      throw new Error("No valid Jito tip accounts available");
    }

    // Cache the fallback (but mark it as potentially stale)
    this.tipAccountsCache = fallbackAccounts;
    this.tipAccountsAt = now - tipAccountsTtlMs - 1; // Force a refresh on the next call

    return fallbackAccounts;
  }

  /**
   * Get the last error encountered when fetching tip accounts.
   * Useful for alerting on persistent API failures.
   */
  getTipAccountsLastError(): Error | null {
    return this.tipAccountsLastError;
  }

  // Tip = plain SOL transfer to the current leader's tip account.
  // MUST be the FIRST tx in the bundle and share the same blockhash.
  async buildTipTx(payer: Keypair, blockhash: string, lamports: number): Promise<Transaction> {
    const accounts = await this.tipAccounts();
    if (accounts.length === 0) {
      throw new Error('no tip accounts available');
    }
    const tipAccount = accounts[Math.floor(Math.random() * accounts.length)]!;
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipAccount,
      lamports,
    }));
    tx.sign(payer);
    return tx;
  }

  /**
   * All txs must be signed, share one recent blockhash, and the tip tx must
   * be first.
   *
   * DUPLICATE-SUBMISSION SAFETY
   * ---------------------------
   * `sendBundle` is NOT idempotent: the block engine has no client-supplied
   * request id, so a second submission of the same signed transactions is a
   * second chance to land them. The previous implementation retried on any
   * thrown error — including a client-side `AbortSignal.timeout`, which
   * fires while the request may already have been accepted server-side.
   * That is the textbook double-order: request times out at 3s, retry
   * succeeds, both land, and the wallet holds 2x the intended size at a
   * worse average price.
   *
   * The rule applied here: only retry errors that are *provably* pre-send.
   * Anything ambiguous (timeout, aborted socket, 5xx, network reset) means
   * the bundle may be in flight, so we stop and surface an ambiguous-send
   * error. The caller must then reconcile via `bundleStatus()` /
   * `waitForLanding()` rather than blindly re-sending.
   */
  async sendBundle(txs: Transaction[]): Promise<string> {
    const wire = txs.map((t) => bs58.encode(t.serialize()));
    const retries = this.opts.retries ?? 5;
    const backoff = this.opts.backoffMs ?? 250;
    let lastErr: unknown;

    for (let i = 0; i < retries; i++) {
      try {
        return (await this.rpc("sendBundle", [wire])) as string; // bundle uuid
      } catch (err) {
        lastErr = err;

        if (!isDefinitelyNotSent(err)) {
          throw new AmbiguousSendError(
            "jito sendBundle outcome is unknown — the bundle may already be in flight; " +
              "reconcile before re-sending",
            err,
          );
        }

        if (i < retries - 1) {
          await new Promise((r) => setTimeout(r, backoff * 2 ** i));
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("jito sendBundle failed");
  }

  /**
   * Poll a bundle to a terminal state.
   *
   * Transient poll failures no longer abort the wait: an RPC hiccup while
   * waiting is not evidence about whether the bundle landed, and throwing
   * here previously left the caller with an in-flight bundle it had stopped
   * tracking. Only a definitive `Landed`/`Invalid`, or the deadline, ends
   * the loop.
   *
   * "Timeout" explicitly does NOT mean "did not land" — the bundle can land
   * after the deadline. Callers must treat it as unknown.
   */
  async waitForLanding(
    bundleId: string,
    timeoutMs = 30_000,
    pollMs = this.opts.pollMs ?? 300,
  ): Promise<{
    status: BundleStatus | "Timeout";
    bundleId: string;
    pollErrors: number;
    transactions?: string[];
  }> {
    const deadline = Date.now() + timeoutMs;
    let pollErrors = 0;

    while (Date.now() < deadline) {
      try {
        const status = await this.bundleStatus(bundleId);
        if (status === "Landed" || status === "Invalid") {
          const details = await this.bundleDetails(bundleId);
          return details?.transactions
            ? { status, bundleId, pollErrors, transactions: details.transactions }
            : { status, bundleId, pollErrors };
        }
      } catch {
        pollErrors += 1;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    return { status: "Timeout", bundleId, pollErrors };
  }

  /** Single status probe. Used for post-ambiguity reconciliation. */
  async bundleStatus(bundleId: string): Promise<BundleStatus | "Unknown"> {
    return (await this.bundleDetails(bundleId))?.status ?? "Unknown";
  }

  async bundleDetails(bundleId: string): Promise<InflightStatus | null> {
    const res = (await this.rpc("getInflightBundleStatuses", [[bundleId]])) as {
      value?: InflightStatus[];
    };
    return res?.value?.[0] ?? null;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3_000),
      });
    } catch (err) {
      // Transport-level failure: the request may or may not have reached
      // the block engine. Tag it so sendBundle can refuse to retry.
      throw new TransportError(`jito ${method}: ${describe(err)}`, err);
    }

    if (!res.ok) {
      // 4xx is a rejected request (never executed). 5xx and 429 are
      // ambiguous — the engine may have accepted it before failing.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new RejectedError(`jito ${method}: HTTP ${res.status}`);
      }
      throw new TransportError(`jito ${method}: HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };

    // A JSON-RPC error body means the engine processed and refused the
    // request — that is a definitive rejection, safe to retry.
    if (body.error) {
      throw new RejectedError(`jito ${method}: ${body.error.message ?? "rpc error"}`);
    }

    return body.result;
  }
}

/** The request was received and refused. Safe to retry. */
export class RejectedError extends Error {
  readonly retryable = true;
}

/**
 * The request may or may not have been received. NOT safe to retry.
 *
 * Uses the native ES2022 `cause` option rather than declaring its own
 * `cause` property — a parameter property here shadows `Error.cause` and
 * loses the standard error-chaining that logging and diagnostics rely on.
 */
export class TransportError extends Error {
  readonly retryable = false;
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TransportError';
  }
}

/** Raised when a send could not be proven to have not happened. */
export class AmbiguousSendError extends Error {
  readonly retryable = false;
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AmbiguousSendError';
  }
}

function isDefinitelyNotSent(err: unknown): boolean {
  return err instanceof RejectedError;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "TimeoutError" ? "request timed out" : err.message;
  }
  return String(err);
}