
import {
  Connection,
  PublicKey,
  Commitment,
  TransactionSignature,
  BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import { TOKEN_PROGRAMS } from './constants';

const MAX_FAILURES_BEFORE_SWITCH = 3;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** How long to stay on the backup before probing the primary again. */
const DEFAULT_FAILBACK_AFTER_MS = 60_000;

export interface SolanaConnectionOptions {
  commitment?: Commitment;
  /** Consecutive failures before switching endpoints. */
  maxFailuresBeforeSwitch?: number;
  /** Time on backup before attempting to fail back to primary. */
  failbackAfterMs?: number;
  now?: () => number;
}

/**
 * Blockhash context captured at signing time.
 *
 * Confirmation MUST use the blockhash the transaction was actually signed
 * with. Fetching a fresh blockhash at confirmation time (as this class
 * previously did) produces a `lastValidBlockHeight` far in the future, so
 * an expired transaction never reports as expired and the caller waits on
 * a signature that can no longer land.
 */
export interface SignedBlockhashContext {
  blockhash: string;
  lastValidBlockHeight: number;
}

export type ConfirmOutcome =
  | { status: 'confirmed'; slot: number | null }
  | { status: 'failed'; reason: string }
  | { status: 'expired' };

export class SolanaConnection {
  private readonly primaryUrl: string;
  private readonly backupUrl: string | undefined;
  private readonly commitment: Commitment;
  private readonly maxFailuresBeforeSwitch: number;
  private readonly failbackAfterMs: number;
  private readonly now: () => number;

  private connection: Connection;
  private usingBackup = false;
  private consecutiveFailures = 0;
  private switchedToBackupAt: number | null = null;

  constructor(
    rpcUrl: string,
    backupRpcUrl?: string,
    options: SolanaConnectionOptions = {},
  ) {
    this.primaryUrl = rpcUrl;
    this.backupUrl = backupRpcUrl;
    this.commitment = options.commitment ?? 'confirmed';
    this.maxFailuresBeforeSwitch =
      options.maxFailuresBeforeSwitch ?? MAX_FAILURES_BEFORE_SWITCH;
    this.failbackAfterMs = options.failbackAfterMs ?? DEFAULT_FAILBACK_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
    this.connection = new Connection(rpcUrl, this.commitment);
  }

  getConnection(): Connection {
    return this.connection;
  }

  switchToBackup(): void {
    if (!this.backupUrl) {
      throw new Error('No backup RPC URL configured');
    }
    this.connection = new Connection(this.backupUrl, this.commitment);
    this.usingBackup = true;
    this.switchedToBackupAt = this.now();
    this.consecutiveFailures = 0;
  }

  /**
   * Return to the primary endpoint. Called opportunistically once the
   * backup has been in use longer than `failbackAfterMs` — without this the
   * process stays pinned to the (often slower, often rate-limited) backup
   * for its entire lifetime after a single transient primary blip.
   */
  failBackToPrimary(): void {
    if (!this.usingBackup) return;
    this.connection = new Connection(this.primaryUrl, this.commitment);
    this.usingBackup = false;
    this.switchedToBackupAt = null;
    this.consecutiveFailures = 0;
  }

  isUsingBackup(): boolean {
    return this.usingBackup;
  }

  getHealth(): {
    usingBackup: boolean;
    consecutiveFailures: number;
    backupConfigured: boolean;
  } {
    return {
      usingBackup: this.usingBackup,
      consecutiveFailures: this.consecutiveFailures,
      backupConfigured: Boolean(this.backupUrl),
    };
  }

  private maybeFailBack(): void {
    if (
      this.usingBackup &&
      this.switchedToBackupAt !== null &&
      this.now() - this.switchedToBackupAt >= this.failbackAfterMs
    ) {
      this.failBackToPrimary();
    }
  }

  private async withAutoSwitch<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeFailBack();

    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures++;

      const shouldSwitch =
        this.consecutiveFailures >= this.maxFailuresBeforeSwitch &&
        Boolean(this.backupUrl) &&
        !this.usingBackup;

      if (!shouldSwitch) {
        throw error;
      }

      this.switchToBackup();

      // Retry exactly once on the backup. If the backup also fails, the
      // caller sees the backup's error — retrying further here would hide
      // a total-outage condition behind an unbounded loop.
      return fn();
    }
  }

  async getBalance(pubkey: string): Promise<number> {
    return this.withAutoSwitch(async () => {
      const balance = await this.connection.getBalance(new PublicKey(pubkey));
      return balance / LAMPORTS_PER_SOL;
    });
  }

  /**
   * Token balances across BOTH SPL Token and Token-2022.
   *
   * Querying a single program (and previously, an incorrect program id)
   * silently returned an empty map, which reads downstream as "the wallet
   * holds nothing" — the most dangerous possible wrong answer for a
   * reconciliation or sell-all path.
   */
  async getTokenBalances(pubkey: string): Promise<Map<string, number>> {
    return this.withAutoSwitch(async () => {
      const owner = new PublicKey(pubkey);
      const balances = new Map<string, number>();

      for (const programId of TOKEN_PROGRAMS) {
        const tokenAccounts =
          await this.connection.getParsedTokenAccountsByOwner(owner, {
            programId,
          });

        for (const account of tokenAccounts.value) {
          const parsed = account.account.data.parsed;
          const mint: string | undefined = parsed?.info?.mint;
          const amount: number = parsed?.info?.tokenAmount?.uiAmount ?? 0;

          if (typeof mint !== 'string' || !Number.isFinite(amount)) continue;
          if (amount <= 0) continue;

          // Same mint cannot appear under both programs, but a wallet can
          // legitimately hold several accounts for one mint.
          balances.set(mint, (balances.get(mint) ?? 0) + amount);
        }
      }

      return balances;
    });
  }

  async getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    return this.withAutoSwitch(() =>
      this.connection.getLatestBlockhash(this.commitment),
    );
  }

  /**
   * Confirm a transaction against the blockhash it was signed with.
   *
   * Returns a discriminated outcome instead of throwing/resolving void so
   * callers are forced to distinguish "landed", "chain rejected it", and
   * "blockhash expired, it will never land". Treating all three as success
   * is how a phantom position gets booked.
   */
  async confirmTransaction(
    signature: TransactionSignature,
    context: SignedBlockhashContext,
    commitment: Commitment = this.commitment,
  ): Promise<ConfirmOutcome> {
    if (!context?.blockhash || !Number.isFinite(context.lastValidBlockHeight)) {
      throw new Error(
        'confirmTransaction requires the blockhash context the transaction was signed with',
      );
    }

    try {
      const result = await this.connection.confirmTransaction(
        {
          signature,
          blockhash: context.blockhash,
          lastValidBlockHeight: context.lastValidBlockHeight,
        },
        commitment,
      );

      if (result.value.err) {
        return {
          status: 'failed',
          reason:
            typeof result.value.err === 'string'
              ? result.value.err
              : JSON.stringify(result.value.err),
        };
      }

      return { status: 'confirmed', slot: result.context?.slot ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // web3.js surfaces blockhash expiry as a TransactionExpiredBlockheight
      // error. That is a terminal, non-retryable state: the transaction can
      // never land, so the caller must NOT treat it as "still pending".
      if (/expired|blockheight exceeded/i.test(message)) {
        return { status: 'expired' };
      }

      throw error;
    }
  }
}
