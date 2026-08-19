import {
  Connection,
  PublicKey,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  ParsedTransactionWithMeta,
  Logs,
} from '@solana/web3.js';
import { postInternalFlow } from './internal-client';

import { TokenDiscoveryProvider } from './provider';
import {
  TokenCallback,
  TokenDiscoveryEvent,
  LiquidityCallback,
} from './types';

const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

/**
 * pump.fun bonding-curve program.
 *
 * Watching this instead of the token programs is the difference between a
 * usable RPC budget and a saturated one. `onLogs(TOKEN_PROGRAM_ID)`
 * subscribes to every transaction that touches SPL Token — i.e. most of
 * Solana — and every one of those that mentions `initializeMint` costs a
 * `getParsedTransaction`. Mint-creation spam alone is thousands per minute.
 *
 * The pump.fun program emits far fewer events, and its `create` instruction
 * CPIs into the token program, so `initializeMint` still appears in the
 * transaction's inner instructions. The same parsing finds the same mints —
 * from a stream orders of magnitude smaller.
 */
const PUMP_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);

/** Named program sets a caller can select between. */
export const DISCOVERY_SCOPES = {
  /** Every SPL mint on Solana. Complete, and very expensive. */
  allMints: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
  /** pump.fun launches only. */
  pumpFun: [PUMP_PROGRAM_ID],
} as const;

const MAX_SEEN_SIGNATURES = 5_000;
const MAX_SEEN_MINTS = 10_000;
const RPC_RETRY_BASE_MS = 1_000;
const RPC_MAX_RETRIES = 4;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_BATCH_SIZE = 10;

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

type MintInfo = {
  decimals: number;
  supply: number;
  supplyRaw: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
};

export class SolanaTokenProvider implements TokenDiscoveryProvider {
  readonly name = 'solana-onchain';

  private readonly connection: Connection;
  private readonly wsConnection: Connection;
  private readonly tokenCallbacks: TokenCallback[] = [];
  private readonly liquidityCallbacks: LiquidityCallback[] = [];

  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private subscriptionIds: number[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private started = false;

  private readonly seenSignatures = new Set<string>();
  private readonly seenMints = new Set<string>();

  /** Programs whose logs are watched. See DISCOVERY_SCOPES. */
  private readonly programs: readonly PublicKey[];
  /** Whether the polling fallback runs at all. */
  private readonly pollingEnabled: boolean;
  /** Whether websocket log subscriptions are opened. */
  private readonly subscriptionsEnabled: boolean;

  /** 0 = unlimited. See the constructor option for why this matters. */
  private readonly maxDiscoveriesPerMinute: number;
  private budgetWindowStart = Date.now();
  private budgetUsed = 0;
  private budgetSkipped = 0;

  /**
   * Fixed-window budget check.
   *
   * Deliberately not a queue: dropping is the correct behaviour when the
   * work has a short shelf life. Returns false when the caller should skip
   * this discovery entirely (before spending any RPC on it).
   */
  private withinDiscoveryBudget(): boolean {
    if (this.maxDiscoveriesPerMinute <= 0) return true;

    const now = Date.now();
    if (now - this.budgetWindowStart >= 60_000) {
      if (this.budgetSkipped > 0) {
        console.warn(
          `[${this.name}] discovery budget: processed ${this.budgetUsed}, ` +
            `skipped ${this.budgetSkipped} in the last minute ` +
            `(cap ${this.maxDiscoveriesPerMinute}/min)`,
        );
      }
      this.budgetWindowStart = now;
      this.budgetUsed = 0;
      this.budgetSkipped = 0;
    }

    if (this.budgetUsed >= this.maxDiscoveriesPerMinute) {
      this.budgetSkipped += 1;
      return false;
    }

    this.budgetUsed += 1;
    return true;
  }

  constructor(
    rpcUrl: string,
    options?: {
      pollIntervalMs?: number;
      batchSize?: number;
      /**
       * Programs to watch. Defaults to the full mint stream for backwards
       * compatibility; pass DISCOVERY_SCOPES.pumpFun to watch only
       * pump.fun, which is dramatically cheaper.
       */
      programs?: readonly PublicKey[];
      /**
       * Polling. Re-reads recent signatures per watched program and fetches
       * a parsed transaction for each unseen one.
       *
       * Cost is BOUNDED and predictable: (1 + batchSize) calls per program
       * per interval, regardless of chain activity. That is its advantage
       * over the subscription below, whose cost is set by how busy the
       * watched program is.
       */
      pollingEnabled?: boolean;
      /**
       * Websocket log subscriptions.
       *
       * `onLogs(program)` delivers a message for EVERY transaction touching
       * that program. For the SPL Token program that is most of Solana; for
       * the pump.fun program it is every buy and sell, not just launches.
       * The `initializeMint` filter is applied locally, so the filtering is
       * cheap — but the stream still has to be received and billed.
       *
       * Lower latency than polling, unbounded cost. On a rate-limited
       * endpoint, bounded polling is usually the better trade.
       */
      subscriptionsEnabled?: boolean;
      /**
       * Hard ceiling on how many discoveries are processed per minute.
       *
       * This is the only control that makes RPC load independent of market
       * activity. Every discovery costs a `getParsedTransaction` before any
       * downstream filter applies, and pump.fun mints several tokens per
       * second at peak — so without a cap, the launch rate sets the request
       * rate, and a rate-limited endpoint simply fails.
       *
       * Excess discoveries are DROPPED, not queued. A launch seen a minute
       * late is not a trade; queueing would only add latency to work whose
       * value has already expired, while still spending the request.
       */
      maxDiscoveriesPerMinute?: number;
    },
  ) {
    if (!rpcUrl || !rpcUrl.trim()) {
      throw new Error('Solana RPC URL is required');
    }

    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options?.batchSize ?? DEFAULT_POLL_BATCH_SIZE;
    this.programs = options?.programs ?? DISCOVERY_SCOPES.allMints;
    this.pollingEnabled = options?.pollingEnabled ?? true;
    this.subscriptionsEnabled = options?.subscriptionsEnabled ?? true;
    this.maxDiscoveriesPerMinute = options?.maxDiscoveriesPerMinute ?? 0;

    if (!this.pollingEnabled && !this.subscriptionsEnabled) {
      throw new Error(
        'SolanaTokenProvider needs polling or subscriptions enabled; ' +
          'with both off it can never discover a token.',
      );
    }

    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 250) {
      throw new Error('pollIntervalMs must be an integer >= 250');
    }

    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1000) {
      throw new Error('batchSize must be an integer between 1 and 1000');
    }

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    });

    const wsUrl = rpcUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:');

    this.wsConnection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
      /*
       * Match the polling connection: do NOT let web3.js retry a 429 for us.
       *
       * Its built-in handler retries the same request several times with a
       * short backoff, so on a rate-limited endpoint one refused call becomes
       * several — the discovery budget above caps how many lookups are
       * STARTED, but cannot cap what the client retries underneath it. That
       * is how a mild overage sustains itself as a 429 storm.
       *
       * A dropped discovery is the correct outcome here. The work has a
       * short shelf life, and the retry was spending budget that the price
       * reads for open positions need.
       */
      disableRetryOnRateLimit: true,
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      const budget = this.pollingEnabled
        ? `~${this.programs.length * (1 + this.batchSize)} calls per ${this.pollIntervalMs}ms`
        : 'unbounded (subscription-driven)';

      console.log(
        `[${this.name}] watching ${this.programs.length} program(s); ` +
          `subscriptions ${this.subscriptionsEnabled ? 'on' : 'off'}; ` +
          `polling ${this.pollingEnabled ? `every ${this.pollIntervalMs}ms` : 'off'}; ` +
          `request budget: ${budget}`,
      );

      if (this.subscriptionsEnabled) {
        for (const programId of this.programs) {
          this.subscribeToProgram(programId, programId.toBase58());
        }
      }

      if (this.pollingEnabled) {
        this.pollTimer = setInterval(() => {
          void this.pollRecentTransactions();
        }, this.pollIntervalMs);

        await this.pollRecentTransactions();
      }
    } catch (error) {
      await this.cleanupSubscriptions();
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && this.subscriptionIds.length === 0 && this.pollTimer === null) {
      return;
    }

    this.started = false;

    await this.cleanupSubscriptions();

    console.log(`[${this.name}] stopped`);
  }

  onToken(callback: TokenCallback): void {
    this.tokenCallbacks.push(callback);
  }

  onLiquidityChange(callback: LiquidityCallback): void {
    this.liquidityCallbacks.push(callback);
  }

  private subscribeToProgram(programId: PublicKey, label: string): void {
    try {
      const id = this.wsConnection.onLogs(
        programId,
        async (logs: Logs) => {
          if (!this.started || logs.err) {
            return;
          }

          const hasInit = logs.logs.some(
            (line) =>
              line.includes('InitializeMint') ||
              line.includes('initializeMint'),
          );

          if (!hasInit || this.seenSignatures.has(logs.signature)) {
            return;
          }

          // Budget check BEFORE the signature is marked seen and before
          // processSignature spends a getParsedTransaction. Checking later
          // would already have cost the request this cap exists to prevent.
          if (!this.withinDiscoveryBudget()) {
            return;
          }

          this.seenSignatures.add(logs.signature);

          try {
            await this.processSignature(logs.signature);
          } catch (error) {
            // A failed transaction lookup is not a reason to kill the provider.
            // Keep the signature cached so a duplicate WS event cannot fan out.
            console.warn(
              `[${this.name}] WS processing failed ${logs.signature}:`,
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            this.trimSeenSignatures();
          }
        },
        'confirmed',
      );

      this.subscriptionIds.push(id);
      console.log(`[${this.name}] subscribed to ${label} logs (id=${id})`);
    } catch (error) {
      console.warn(
        `[${this.name}] WebSocket subscription failed for ${label}; polling fallback will continue:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async pollRecentTransactions(): Promise<void> {
    if (this.polling || !this.started) {
      return;
    }

    this.polling = true;

    let scanned = 0;
    let discovered = 0;

    try {
      for (const programId of this.programs) {
        const signatures = await this.withRetry(() =>
          this.connection.getSignaturesForAddress(
            programId,
            { limit: this.batchSize },
            'confirmed',
          ),
        );

        scanned += signatures.length;

        for (const sigInfo of signatures) {
          if (sigInfo.err || this.seenSignatures.has(sigInfo.signature)) {
            continue;
          }

          this.seenSignatures.add(sigInfo.signature);

          try {
            const result = await this.processSignature(sigInfo.signature);
            discovered += result.discovered;
          } catch (error) {
            console.warn(
              `[${this.name}] tx processing failed ${sigInfo.signature}:`,
              error instanceof Error ? error.message : String(error),
            );
          }

          await this.sleep(50);
        }
      }

      this.trimSeenSignatures();
      this.trimSeenMints();

      console.log(
        `[${this.name}] poll: scanned=${scanned} discovered=${discovered}`,
      );
    } catch (error) {
      console.warn(
        `[${this.name}] poll failed:`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.polling = false;
    }
  }

  private async processSignature(
    signature: string,
  ): Promise<{ discovered: number }> {
    const tx = await this.withRetry(() =>
      this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      }),
    );

    if (!tx?.meta || tx.meta.err) {
      return { discovered: 0 };
    }

    // Parse and post any pump.fun fills present in this transaction (best-effort)
    try {
      const fills = this.parsePumpFills(tx, signature);
      for (const f of fills) {
        const obs: any = {
          type: 'transaction',
          mint: f.mint,
          ts: f.ts,
          signature: signature,
          side: f.side,
          volumeSol: f.volumeSol,
          buyer: f.buyer ?? null,
          seller: f.seller ?? null,
          price: f.price ?? null,
          source: this.name,
        };
        try {
          // Best-effort: do not block discovery on network errors
          void (async () => {
            console.log(JSON.stringify({ event: 'FLOW_POST_ATTEMPT', mint: obs.mint, type: obs.type, signature: obs.signature ?? null }));
            await postInternalFlow(obs);
          })();
        } catch {}
      }
    } catch (err) {
      // best-effort parsing; swallow errors
    }

    const initializeMints = new Set<string>();

    for (const instruction of tx.transaction.message.instructions) {
      this.inspectInstruction(instruction, initializeMints);
    }

    if (tx.meta.innerInstructions) {
      for (const innerGroup of tx.meta.innerInstructions) {
        for (const instruction of innerGroup.instructions) {
          this.inspectInstruction(instruction, initializeMints);
        }
      }
    }

    let discovered = 0;

    for (const mint of initializeMints) {
      if (this.seenMints.has(mint)) {
        continue;
      }

      this.seenMints.add(mint);
      await this.emitTokenEvent(mint, signature, tx);
      discovered++;
    }

    this.trimSeenMints();
    return { discovered };
  }

  private inspectInstruction(
    instruction: AnyInstruction,
    initializeMints: Set<string>,
  ): void {
    if (!('parsed' in instruction)) {
      return;
    }

    if (
      instruction.program !== 'spl-token' &&
      instruction.program !== 'spl-token-2022'
    ) {
      return;
    }

    const parsed = instruction.parsed;
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const type = parsed.type;
    if (type !== 'initializeMint' && type !== 'initializeMint2') {
      return;
    }

    const info = parsed.info;
    if (
      !info ||
      typeof info !== 'object' ||
      typeof info.mint !== 'string'
    ) {
      return;
    }

    try {
      new PublicKey(info.mint);
    } catch {
      return;
    }

    initializeMints.add(info.mint);
  }

  private async emitTokenEvent(
    mint: string,
    signature: string,
    tx: ParsedTransactionWithMeta,
  ): Promise<void> {
    const info = await this.getMintInfo(mint);
    const blockTime = tx.blockTime ?? Math.floor(Date.now() / 1000);

    // accountKeys[0] is the transaction fee payer, not necessarily the mint
    // creator. Do not promote an account-order assumption into provenance.
    const creator = 'unknown';

    const event: TokenDiscoveryEvent = {
      tokenMint: mint,
      creator,
      creatorSource: 'not-determined',
      createdAt: new Date(blockTime * 1000),
      poolAddress: null,
      quoteToken: null,
      initialLiquidity: null,
      decimals: info.decimals,
      name: null,
      symbol: null,
      supply: info.supply,
      supplyRaw: info.supplyRaw,
      mintAuthority: info.mintAuthority,
      freezeAuthority: info.freezeAuthority,
      metadataUri: null,
      txSignature: signature,
      source: this.name,
    };

    console.log(
      `[${this.name}] TOKEN_DISCOVERED mint=${mint} sig=${signature}`,
    );

    // Post a normalized observation to the local API (best-effort, non-blocking)
    try {
      const obs = {
        type: 'transaction',
        mint,
        ts: (tx.blockTime ? tx.blockTime * 1000 : Date.now()),
        signature,
        side: 'buy', // discovery of initializeMint treated as a buy event for flow
        volumeSol: 0,
        buyer: null,
        seller: null,
      };
      console.log(JSON.stringify({ event: 'FLOW_POST_ATTEMPT', mint: obs.mint, type: obs.type, signature: obs.signature ?? null }));
      void postInternalFlow(obs);
    } catch {}

    for (const callback of this.tokenCallbacks) {
      try {
        await callback(event);
      } catch (error) {
        console.warn(
          `[${this.name}] token callback failed mint=${mint}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async getMintInfo(mint: string): Promise<MintInfo> {
    try {
      const publicKey = new PublicKey(mint);
      const accountInfo = await this.withRetry(() =>
        this.connection.getParsedAccountInfo(publicKey, 'confirmed'),
      );

      const value = accountInfo.value;
      if (value && 'parsed' in value.data) {
        const parsed = value.data.parsed;

        if (parsed && typeof parsed === 'object' && 'info' in parsed) {
          const info = parsed.info as {
            decimals?: unknown;
            supply?: unknown;
            mintAuthority?: unknown;
            freezeAuthority?: unknown;
          };

          const supplyRaw =
            typeof info.supply === 'string'
              ? info.supply
              : typeof info.supply === 'number' && Number.isFinite(info.supply)
                ? String(info.supply)
                : '0';

          const supplyNumber = Number(supplyRaw);

          return {
            decimals:
              typeof info.decimals === 'number' && Number.isInteger(info.decimals)
                ? info.decimals
                : 9,
            supply: Number.isSafeInteger(supplyNumber)
              ? supplyNumber
              : Number.MAX_SAFE_INTEGER,
            supplyRaw,
            mintAuthority:
              typeof info.mintAuthority === 'string'
                ? info.mintAuthority
                : null,
            freezeAuthority:
              typeof info.freezeAuthority === 'string'
                ? info.freezeAuthority
                : null,
          };
        }
      }
    } catch (error) {
      console.warn(
        `[${this.name}] mint info lookup failed ${mint}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    return {
      decimals: 9,
      supply: 0,
      supplyRaw: '0',
      mintAuthority: null,
      freezeAuthority: null,
    };
  }

  // Best-effort: parse pump.fun buy fills from a parsed transaction.
  private parsePumpFills(tx: ParsedTransactionWithMeta, signature: string) {
    const fills: Array<{ mint: string; ts: number; side: string; buyer?: string | null; seller?: string | null; volumeSol: number; price?: number | null }> = [];
    try {
      const LAMPORTS_PER_SOL = 1_000_000_000;
      const insns: any[] = [];
      if (Array.isArray(tx.transaction.message.instructions)) insns.push(...(tx.transaction.message.instructions as any[]));
      if (tx.meta?.innerInstructions) {
        for (const grp of tx.meta.innerInstructions) insns.push(...(grp.instructions as any[]));
      }

      for (const ix of insns) {
        try {
          const prog = (ix as any).programId ?? null;
          if (!prog || typeof (prog.equals) !== 'function') continue;
          if (!prog.equals(PUMP_PROGRAM_ID)) continue;
          if (typeof (ix as any).data !== 'string') continue;

          // accounts: [global, fee_recipient, mint, bondingCurve, associatedBondingCurve, associatedUser, user, ...]
          const accounts = (ix as any).accounts ?? [];
          const mint = typeof accounts[2] === 'string' ? accounts[2] : null;
          const user = typeof accounts[6] === 'string' ? accounts[6] : null;
          if (!mint) continue;

          const data = Buffer.from((ix as any).data, 'base64');
          let maxSolCost = null as bigint | null;
          if (data.length >= 24) {
            maxSolCost = data.readBigUInt64LE(16);
          }

          // Try to compute actual lamports spent by examining pre/post balances for the user
          let lamportsSpent: number | null = null;
          try {
            if (user && Array.isArray(tx.transaction.message.accountKeys) && tx.meta?.preBalances && tx.meta?.postBalances) {
              const keys: string[] = tx.transaction.message.accountKeys.map((a: any) => a.pubkey?.toBase58?.() ?? a.pubkey ?? a);
              const idx = keys.indexOf(user);
              if (idx >= 0 && typeof tx.meta.preBalances[idx] === 'number' && typeof tx.meta.postBalances[idx] === 'number') {
                const pre = tx.meta.preBalances[idx];
                const post = tx.meta.postBalances[idx];
                const spent = pre - post;
                if (spent >= 0) lamportsSpent = spent;
              }
            }
          } catch {}

          // Fallback to maxSolCost if balances not available
          if (lamportsSpent === null && maxSolCost !== null) {
            // convert bigint lamports to number SOL
            lamportsSpent = Number(maxSolCost);
          }

          const volumeSol = lamportsSpent !== null ? lamportsSpent / LAMPORTS_PER_SOL : 0;

          // Attempt to derive token amount delta to compute price
          let price: number | null = null;
          try {
            const mintStr = mint;
            if (tx.meta?.preTokenBalances && tx.meta?.postTokenBalances) {
              const pre = tx.meta.preTokenBalances.find((b: any) => b.mint === mintStr && b.owner === user);
              const post = tx.meta.postTokenBalances.find((b: any) => b.mint === mintStr && b.owner === user);
              const preAmt = pre?.uiTokenAmount?.uiAmount ?? (pre?.uiTokenAmount?.amount ? Number(pre.uiTokenAmount.amount) : null);
              const postAmt = post?.uiTokenAmount?.uiAmount ?? (post?.uiTokenAmount?.amount ? Number(post.uiTokenAmount.amount) : null);
              if (typeof preAmt === 'number' && typeof postAmt === 'number') {
                const tokensOut = postAmt - preAmt;
                if (tokensOut > 0 && volumeSol > 0) {
                  price = volumeSol / tokensOut;
                }
              }
            }
          } catch {}

          fills.push({ mint, ts: (tx.blockTime ? tx.blockTime * 1000 : Date.now()), side: 'buy', buyer: user ?? null, seller: null, volumeSol, price });
        } catch {}
      }
    } catch {}
    return fills;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RPC_MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (!this.isRetryableRpcError(error) || attempt >= RPC_MAX_RETRIES) {
          break;
        }

        const exponential = RPC_RETRY_BASE_MS * 2 ** attempt;
        const jitter = Math.floor(Math.random() * 250);
        const delay = exponential + jitter;

        console.warn(
          `[${this.name}] transient RPC failure; retry ${attempt + 1}/${RPC_MAX_RETRIES} after ${delay}ms`,
        );

        await this.sleep(delay);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private isRetryableRpcError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    return (
      normalized.includes('429') ||
      normalized.includes('too many requests') ||
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('econnreset') ||
      normalized.includes('econnrefused') ||
      normalized.includes('socket hang up') ||
      normalized.includes('503') ||
      normalized.includes('502') ||
      normalized.includes('500')
    );
  }

  private async cleanupSubscriptions(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const ids = this.subscriptionIds;
    this.subscriptionIds = [];

    const results = await Promise.allSettled(
      ids.map((id) => this.wsConnection.removeOnLogsListener(id)),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(
          `[${this.name}] failed removing WebSocket listener:`,
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        );
      }
    }

    this.polling = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private trimSeenSignatures(): void {
    if (this.seenSignatures.size <= MAX_SEEN_SIGNATURES) {
      return;
    }

    const entries = [...this.seenSignatures];
    this.seenSignatures.clear();

    for (const signature of entries.slice(-Math.floor(MAX_SEEN_SIGNATURES / 2))) {
      this.seenSignatures.add(signature);
    }
  }

  private trimSeenMints(): void {
    if (this.seenMints.size <= MAX_SEEN_MINTS) {
      return;
    }

    const entries = [...this.seenMints];
    this.seenMints.clear();

    for (const mint of entries.slice(-Math.floor(MAX_SEEN_MINTS / 2))) {
      this.seenMints.add(mint);
    }
  }
}