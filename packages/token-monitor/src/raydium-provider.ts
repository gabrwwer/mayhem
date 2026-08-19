import {
  Connection,
  Logs,
  PublicKey,
} from '@solana/web3.js';
import { TokenDiscoveryProvider } from './provider';
import {
  RaydiumPoolVerifier,
  type VerifiedRaydiumPool,
} from './raydium-pool-verifier';
import {
  LiquidityCallback,
  TokenCallback,
  TokenDiscoveryEvent,
} from './types';
import {
  RAYDIUM_AMM_V4,
  RAYDIUM_CPMM,
  SOL_MINT,
} from '@mayhem/solana';

const MAX_SEEN = 5000;

export interface RaydiumLpProviderOptions {
  /**
   * Allow verified pools to be emitted as tradeable.
   *
   * Off by default. The verifier proves the pool is real and holds SOL; it
   * does NOT prove the LP is locked or burned, so a verified pool can still
   * be rugged by the deployer pulling liquidity. Enabling this is a
   * deliberate decision about which risks you accept, not a config detail.
   */
  entriesEnabled?: boolean;
}

type ParsedTransactionLike = NonNullable<
  Awaited<ReturnType<Connection['getParsedTransaction']>>
>;

export class RaydiumLpProvider implements TokenDiscoveryProvider {
  name = 'raydium-lp';

  private readonly connection: Connection;
  private readonly wsConnection: Connection;
  private readonly poolVerifier: RaydiumPoolVerifier;
  private readonly tokenCallbacks: TokenCallback[] = [];
  private readonly liquidityCallbacks: LiquidityCallback[] = [];
  private subscriptionIds: number[] = [];
  private readonly seenSignatures = new Set<string>();
  private readonly seenMints = new Set<string>();
  private readonly entriesEnabled: boolean;

  constructor(rpcUrl: string, options: RaydiumLpProviderOptions = {}) {
    if (!rpcUrl?.trim()) {
      throw new Error('Solana RPC URL is required');
    }

    this.entriesEnabled = options.entriesEnabled ?? false;

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    });

    this.poolVerifier = new RaydiumPoolVerifier(rpcUrl);

    const wsUrl = rpcUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:');

    this.wsConnection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
    });
  }

  async start(): Promise<void> {
    if (this.subscriptionIds.length > 0) return;

    console.log(`[${this.name}] subscribing to Raydium AMM V4 + CPMM`);

    this.subscribeToProgram(
      RAYDIUM_AMM_V4,
      'raydium-amm-v4',
      ['initialize2', 'Initialize2'],
    );

    this.subscribeToProgram(
      RAYDIUM_CPMM,
      'raydium-cpmm',
      ['initialize', 'Initialize'],
    );
  }

  async stop(): Promise<void> {
    for (const id of this.subscriptionIds) {
      try {
        await this.wsConnection.removeOnLogsListener(id);
      } catch {}
    }

    this.subscriptionIds = [];
    console.log(`[${this.name}] stopped`);
  }

  onToken(callback: TokenCallback): void {
    this.tokenCallbacks.push(callback);
  }

  onLiquidityChange(callback: LiquidityCallback): void {
    this.liquidityCallbacks.push(callback);
  }

  private subscribeToProgram(
    programId: PublicKey,
    label: string,
    initKeywords: string[],
  ): void {
    try {
      const id = this.wsConnection.onLogs(
        programId,
        async (logs: Logs) => {
          if (logs.err) return;

          const hasInit = logs.logs.some((line) =>
            initKeywords.some((keyword) => line.includes(keyword)),
          );

          if (!hasInit) return;
          if (this.seenSignatures.has(logs.signature)) return;

          this.seenSignatures.add(logs.signature);
          this.trimSeen();

          const startTime = Date.now();

          console.log(
            `[${this.name}] LP_CREATED program=${label} sig=${logs.signature}`,
          );

          try {
            await this.processLpCreation(
              logs.signature,
              label,
              programId.toBase58(),
            );

            console.log(
              `[${this.name}] processed in ${Date.now() - startTime}ms`,
            );
          } catch (error) {
            console.warn(
              `[${this.name}] processing failed ${logs.signature}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        },
        'confirmed',
      );

      this.subscriptionIds.push(id);
      console.log(`[${this.name}] subscribed to ${label} (id=${id})`);
    } catch (error) {
      console.warn(
        `[${this.name}] WebSocket subscription failed for ${label}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async processLpCreation(
    signature: string,
    source: string,
    dexProgramId: string,
  ): Promise<void> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta || tx.meta.err) return;

    const tokenMint = this.extractTokenMint(tx);
    if (!tokenMint) return;
    if (this.seenMints.has(tokenMint)) return;

    const verifiedPool = await this.findVerifiedPool(
      tx,
      dexProgramId,
      tokenMint,
    );

    // Entries on Raydium are opt-in. When disabled, a fully verified pool
    // is still reported for observation, but the event stays marked
    // unverified so the launch handler refuses to trade it — the emitted
    // status is the single switch the trading path reads.
    const entriesEnabled = this.entriesEnabled;
    const verified = verifiedPool !== null && entriesEnabled;

    const creator =
      tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() ?? 'unknown';

    const blockTime = tx.blockTime ?? Math.floor(Date.now() / 1000);

    const event: TokenDiscoveryEvent = {
      tokenMint,
      creator,
      creatorSource: 'not-determined',
      createdAt: new Date(blockTime * 1000),

      // A pool address is only exposed once verifyPool has confirmed:
      // program ownership, a decodable AMM-V4/CPMM state layout, an
      // expected-token/WSOL pair, matching vault mints, a supported token
      // program, and a positive WSOL reserve.
      poolAddress: verified ? verifiedPool!.poolAddress : null,
      quoteToken: verified ? verifiedPool!.quoteMint : null,
      // Real reserves, read from the WSOL vault — not an estimate.
      initialLiquidity: verified ? verifiedPool!.quoteReserveSol : null,

      decimals: 9,
      name: null,
      symbol: null,
      supply: 0,
      mintAuthority: null,
      freezeAuthority: null,
      metadataUri: null,

      txSignature: signature,
      source: `${this.name}:${source}`,

      dexProgramId,
      poolType:
        source === 'raydium-amm-v4'
          ? 'amm-v4'
          : 'cpmm',

      detectedSlot: tx.slot,
      initializationSlot: tx.slot,
      observedViaWebsocket: true,

      poolVerificationStatus: verified ? 'verified' : 'unverified',
      poolVerificationReason: verified
        ? `Verified ${verifiedPool!.poolType} pool ${verifiedPool!.poolAddress} ` +
          `(${verifiedPool!.quoteReserveSol} SOL in the WSOL vault)`
        : verifiedPool
          ? `Verified ${verifiedPool.poolType} pool ${verifiedPool.poolAddress}, but ` +
            'Raydium entries are disabled (RAYDIUM_ENTRIES_ENABLED=false)'
          : 'No fully decoded expected-token/WSOL Raydium pool found in transaction',

      // Vault and reserve data is reported whenever verification succeeded,
      // even with entries disabled — it is observational, and having it in
      // the dashboard is how you judge whether to enable entries at all.
      baseVault: verifiedPool?.baseVault ?? null,
      quoteVault: verifiedPool?.quoteVault ?? null,
      quoteReserveSol: verifiedPool?.quoteReserveSol ?? null,
      totalLiquiditySol: verifiedPool?.quoteReserveSol ?? null,

      lpMint: verifiedPool?.lpMint ?? null,
      lpPositionAddress: null,
      // LP lock/burn is NOT checked yet. Left null rather than false so it
      // reads as "unknown" — claiming an unverified lock is exactly the
      // kind of fabricated assurance that gets a rug traded.
      lpLockOrBurnVerified: null,
    };

    this.seenMints.add(tokenMint);
    this.trimSeen();

    // `pool=unverified` was hardcoded here, so the log said "unverified"
    // even when verification had succeeded — it reported the old
    // observation-only behaviour rather than the actual outcome.
    console.log(
      `[${this.name}] NEW_LP mint=${tokenMint} ` +
        `pool=${verifiedPool?.poolAddress ?? 'none'} ` +
        `status=${event.poolVerificationStatus} ` +
        `reserveSol=${verifiedPool?.quoteReserveSol ?? 'n/a'}`,
    );

    // Post liquidity observation to API for metrics (best-effort)
    try {
      if (typeof globalThis.fetch === 'function' && process.env['API_URL']) {
        const base = process.env['API_URL'].replace(/\/+$/, '');
        const obs = {
          type: 'liquidity',
          mint: tokenMint,
          ts: Date.now(),
          signature,
          liquiditySol: verifiedPool?.quoteReserveSol ?? null,
          curveReserveSol: verifiedPool?.quoteReserveSol ?? null,
          curveProgressPct: null,
          dex: 'raydium',
        };
        void fetch(`${base}/internal/flow`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(obs),
        }).catch(() => {});
      }
    } catch {}

    for (const callback of this.tokenCallbacks) {
      try {
        await callback(event);
      } catch (error) {
        console.warn(
          `[${this.name}] callback error:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /**
   * Locate and fully verify the pool account for this transaction.
   *
   * Returns the complete verification (vaults, reserves, lpMint), not just
   * an address — the caller needs the reserves to populate liquidity, and
   * throwing that away was why Raydium events carried null liquidity.
   *
   * REQUEST COST
   * ------------
   * This previously called `verifyPool` on EVERY account key in the
   * transaction, sequentially. A Raydium LP transaction routinely carries
   * 20+ accounts, and each `verifyPool` is at least one `getAccountInfo`,
   * so a single discovery event cost ~20 sequential round-trips — before
   * any trading decision. On a rate-limited endpoint that alone can
   * saturate the budget during a launch burst.
   *
   * Now: one batched `getMultipleAccountsInfo` narrows the candidates to
   * accounts actually owned by the Raydium program, and only those get the
   * full verification. Typical cost drops to 1 batched call plus one
   * verification (~3 calls).
   */
  private async findVerifiedPool(
    tx: ParsedTransactionLike,
    dexProgramId: string,
    expectedTokenMint: string,
  ): Promise<VerifiedRaydiumPool | null> {
    const candidates = tx.transaction.message.accountKeys
      .map((account) => account.pubkey.toBase58())
      .filter(
        (address) => address !== dexProgramId && address !== SOL_MINT,
      );

    if (candidates.length === 0) return null;

    let ownedByProgram: string[];
    try {
      // getMultipleAccountsInfo caps at 100 keys per call; a transaction
      // cannot exceed that in practice, but slice defensively.
      const infos = await this.connection.getMultipleAccountsInfo(
        candidates.slice(0, 100).map((a) => new PublicKey(a)),
        'confirmed',
      );

      ownedByProgram = candidates.filter((_address, index) => {
        const info = infos[index];
        return Boolean(info) && info!.owner.toBase58() === dexProgramId;
      });
    } catch (error) {
      console.warn(
        `[${this.name}] pool candidate prefilter failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    for (const candidateAddress of ownedByProgram) {
      const result = await this.poolVerifier.verifyPool({
        poolAddress: candidateAddress,
        programId: dexProgramId,
        expectedTokenMint,
      });

      if (result.verified) {
        return result;
      }
    }

    return null;
  }

  private extractTokenMint(tx: ParsedTransactionLike): string | null {
    const accounts = tx.transaction.message.accountKeys;

    for (const account of accounts) {
      const key = account.pubkey.toBase58();

      if (key === SOL_MINT) continue;
      if (key === RAYDIUM_AMM_V4.toBase58()) continue;
      if (key === RAYDIUM_CPMM.toBase58()) continue;

      if (this.looksLikeMint(key, tx)) {
        return key;
      }
    }

    return null;
  }

  private looksLikeMint(
    key: string,
    tx: Pick<ParsedTransactionLike, 'meta'>,
  ): boolean {
    const preBalances = tx.meta?.preTokenBalances ?? [];
    const postBalances = tx.meta?.postTokenBalances ?? [];

    return [...preBalances, ...postBalances].some(
      (balance) => balance.mint === key,
    );
  }

  private trimSeen(): void {
    if (this.seenSignatures.size > MAX_SEEN) {
      const entries = Array.from(this.seenSignatures);

      this.seenSignatures.clear();

      for (const signature of entries.slice(-MAX_SEEN / 2)) {
        this.seenSignatures.add(signature);
      }
    }

    if (this.seenMints.size > MAX_SEEN) {
      const entries = Array.from(this.seenMints);

      this.seenMints.clear();

      for (const mint of entries.slice(-MAX_SEEN / 2)) {
        this.seenMints.add(mint);
      }
    }
  }
}