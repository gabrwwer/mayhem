import { Connection, PublicKey, ParsedTransactionWithMeta, Finality } from '@solana/web3.js';
import { EventEmitter } from "node:events";

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

// Keep these protocol identifiers local so this package does not depend on
// the workspace-only @mayhem/solana path alias at compile time.
const RAYDIUM_AMM_V4 = new PublicKey(
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
);

const RAYDIUM_CPMM = new PublicKey(
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
);

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const INIT_DISCRIMINATORS = [
  'initialize2',
  'Initialize2',
  'initialize',
  'Initialize',
];

export interface PendingLpEvent {
  tokenMint: string;
  poolAddress: string | null;
  signature: string;
  programId: string;
  estimatedLiquidity: number | null;
  detectedAt: number;
}

export type PendingLpCallback = (
  event: PendingLpEvent,
) => void | Promise<void>;

export class MempoolMonitor extends EventEmitter {
  private rpcUrl: string;
  private wsConnection: Connection | null = null;
  private subscriptionIds: number[] = [];
  private callbacks: PendingLpCallback[] = [];
  private seenSignatures = new Set<string>();
  private running = false;

  constructor(rpcUrl: string) {
    super();
    this.rpcUrl = rpcUrl;
  }

  onPendingLp(callback: PendingLpCallback): void {
    this.callbacks.push(callback);
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;

    const wsUrl = this.rpcUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:');

    this.wsConnection = new Connection(this.rpcUrl, {
      commitment: 'processed',
      wsEndpoint: wsUrl,
    });

    console.log(
      '[mempool-monitor] subscribing to pending LP transactions (processed)',
    );

    this.subscribePending(RAYDIUM_AMM_V4, 'raydium-amm-v4');
    this.subscribePending(RAYDIUM_CPMM, 'raydium-cpmm');
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.wsConnection) {
      for (const id of this.subscriptionIds) {
        try {
          await this.wsConnection.removeOnLogsListener(id);
        } catch {}
      }
    }

    this.subscriptionIds = [];
    this.wsConnection = null;

    console.log('[mempool-monitor] stopped');
  }

  private subscribePending(
    programId: PublicKey,
    label: string,
  ): void {
    if (!this.wsConnection) return;

    try {
      const id = this.wsConnection.onLogs(
        programId,
        async (logs) => {
          if (logs.err) return;

          const hasInit = logs.logs.some((line) =>
            INIT_DISCRIMINATORS.some((kw) => line.includes(kw)),
          );

          if (!hasInit) return;

          if (this.seenSignatures.has(logs.signature)) return;

          this.seenSignatures.add(logs.signature);
          this.trimSeen();

          const detectedAt = Date.now();

          console.log(
            `[mempool-monitor] PENDING_LP sig=${logs.signature} ` +
            `program=${label} detected=${detectedAt}`,
          );

          const event = await this.extractPendingEvent(
            logs.signature,
            label,
            detectedAt,
          );

          if (!event) {
            console.log(
              `[mempool-monitor] EVENT_RESOLUTION_FAILED sig=${logs.signature}`,
            );
            return;
          }

          console.log(
            `[mempool-monitor] RESOLVED ` +
            `mint=${event.tokenMint} ` +
            `pool=${event.poolAddress ?? 'unknown'} ` +
            `liquidity=${event.estimatedLiquidity ?? 'unknown'} ` +
            `sig=${event.signature}`,
          );

          for (const cb of this.callbacks) {
            try {
              await cb(event);
            } catch (err) {
              console.warn(
                '[mempool-monitor] callback error:',
                err instanceof Error ? err.message : String(err),
              );
            }
          }

        },
        'processed',
      );

      this.subscriptionIds.push(id);

      console.log(
        `[mempool-monitor] subscribed to ${label} ` +
        `(processed, id=${id})`,
      );
    } catch (err) {
      console.warn(
        `[mempool-monitor] subscription failed for ${label}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * A processed log can arrive before the RPC node has the complete
   * transaction available through getParsedTransaction().
   *
   * Retry briefly instead of immediately generating tokenMint="unknown".
   */
  private async fetchTransactionWithRetry(
    signature: string,
  ): Promise<ParsedTransactionWithMeta | null> {
    if (!this.wsConnection) return null;

    const attempts = 10;
    const delayMs = 75;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const tx = await this.wsConnection.getParsedTransaction(
          signature,
          {
            commitment: 'confirmed' as Finality,
            maxSupportedTransactionVersion: 0,
          },
        );

        if (tx) {
          if (attempt > 1) {
            console.log(
              `[mempool-monitor] TX_RESOLVED_AFTER_RETRY ` +
              `sig=${signature} attempt=${attempt}`,
            );
          }

          return tx;
        }
      } catch (err) {
        if (attempt === attempts) {
          console.warn(
            `[mempool-monitor] transaction lookup failed sig=${signature}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return null;
  }

  private async extractPendingEvent(
    signature: string,
    label: string,
    detectedAt: number,
  ): Promise<PendingLpEvent | null> {
    const tx = await this.fetchTransactionWithRetry(signature);

    if (!tx) {
      console.warn(
        `[mempool-monitor] TX_NOT_AVAILABLE_AFTER_RETRIES sig=${signature}`,
      );

      return null;
    }

    const tokenMint = this.findTokenMint(tx);

    if (!tokenMint) {
      console.warn(
        `[mempool-monitor] TOKEN_MINT_NOT_FOUND sig=${signature}`,
      );

      return null;
    }

    const poolAddress = this.findPoolAddress(tx, label);
    const liquidity = this.estimateLiquidity(tx);

    return {
      tokenMint,
      poolAddress,
      signature,
      programId: label,
      estimatedLiquidity: liquidity,
      detectedAt,
    };
  }

  /**
   * Prefer token balance metadata because accountKeys alone do not tell
   * us which account represents the newly initialized token mint.
   */
  private findTokenMint(tx: ParsedTransactionWithMeta): string | null {
    const preBalances = tx.meta?.preTokenBalances ?? [];
    const postBalances = tx.meta?.postTokenBalances ?? [];

    const candidates = new Map<string, number>();

    for (const balance of [...preBalances, ...postBalances]) {
      const mint = balance?.mint;

      if (!mint) continue;
      if (mint === SOL_MINT) continue;

      const amount =
        Number(balance?.uiTokenAmount?.uiAmount ?? 0);

      candidates.set(
        mint,
        (candidates.get(mint) ?? 0) + amount,
      );
    }

    if (candidates.size === 0) {
      return null;
    }

    /*
     * Prefer the mint with the largest observed token balance.
     * This avoids blindly selecting a random account key.
     */
    let bestMint: string | null = null;
    let bestAmount = -1;

    for (const [mint, amount] of candidates.entries()) {
      if (amount > bestAmount) {
        bestAmount = amount;
        bestMint = mint;
      }
    }

    return bestMint;
  }

  /**
   * Find a plausible Raydium pool account from the instruction account
   * lists rather than blindly assuming accountKeys[4].
   *
   * This remains intentionally conservative. If a reliable pool account
   * cannot be identified, null is returned while the token mint remains
   * usable by the downstream resolver.
   */
  private findPoolAddress(
    tx: ParsedTransactionWithMeta,
    label: string,
  ): string | null {
    const message = tx.transaction?.message;

    if (!message) return null;

    const accountKeys = message.accountKeys ?? [];

    const programId =
      label === 'raydium-cpmm'
        ? RAYDIUM_CPMM.toBase58()
        : RAYDIUM_AMM_V4.toBase58();

    for (const instruction of message.instructions ?? []) {
      const instructionProgramId =
        typeof instruction.programId?.toBase58 === 'function'
          ? instruction.programId.toBase58()
          : '';

      if (instructionProgramId !== programId) continue;

      const accounts = (instruction as any).accounts ?? [];

      /*
       * For parsed instructions, account metadata can differ between
       * Raydium program versions. Return the first valid non-program
       * account only as a candidate rather than asserting it is always
       * the pool.
       */
      for (const account of accounts) {
        const key =
          typeof account === 'string'
            ? account
            : account?.toBase58?.();

        if (!key) continue;
        if (key === programId) continue;
        if (key === SOL_MINT) continue;

        return key;
      }
    }

    /*
     * Fallback: inspect account keys for writable accounts. This is only
     * a fallback and may return null.
     */
    for (const account of accountKeys) {
      const key =
        typeof account === 'string'
          ? account
          : account?.pubkey?.toBase58?.();

      if (!key) continue;

      const isWritable =
        typeof account === 'object'
          ? Boolean(account.writable)
          : false;

      if (isWritable && key !== programId && key !== SOL_MINT) {
        return key;
      }
    }

    return null;
  }

  /**
   * Estimate liquidity from SOL balance movement.
   *
   * This is intentionally treated as an estimate only. The authoritative
   * liquidity value still comes from the Raydium LP discovery provider.
   */
  private estimateLiquidity(
    tx: ParsedTransactionWithMeta,
  ): number | null {
    const pre = tx.meta?.preBalances;
    const post = tx.meta?.postBalances;

    if (!pre || !post) return null;

    let maxDrop = 0;

    const length = Math.min(pre.length, post.length);

    for (let i = 0; i < length; i++) {
      const preBal = pre[i];
      const postBal = post[i];
      if (preBal === undefined || postBal === undefined) continue;
      const drop = (preBal - postBal) / 1e9;

      /*
       * Ignore tiny changes associated with transaction fees.
       */
      if (drop > maxDrop) {
        maxDrop = drop;
      }
    }

    return maxDrop > 0.001 ? maxDrop : null;
  }

  private trimSeen(): void {
    if (this.seenSignatures.size <= 5000) return;

    const entries = Array.from(this.seenSignatures);

    this.seenSignatures.clear();

    for (const signature of entries.slice(-2500)) {
      this.seenSignatures.add(signature);
    }
  }
}

function setTimeout(resolve: (value: unknown) => void, delayMs: number): void {
  globalThis.setTimeout(resolve, delayMs);
}
