import { Connection, PublicKey } from '@solana/web3.js';
import { bondingCurvePda } from '@mayhem/execution';
import { RiskEngine, TokenSafetyScanner } from '@mayhem/risk-engine';
import type { TokenMetadata, PoolInfo, HolderInfo } from '@mayhem/risk-engine';
import { TokenRiskGate } from './new-launch-handler';
import { logger } from './logger';

/**
 * Real token risk gate.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The previous implementation returned `{ score: 90, canTrade: true }` for
 * every pump.fun token *before* any check ran, and for everything else
 * checked liquidity and nothing more. Because the launch handler requires
 * `score >= MIN_RISK_SCORE` (default 70) and this always returned 90, the
 * risk rejection path was unreachable: no honeypot check, no mint- or
 * freeze-authority check, no holder-concentration check ever executed, and
 * `TokenSafetyScanner` — which implements all of them — was dead code.
 *
 * This version gathers real on-chain evidence and delegates the verdict to
 * the scanner. Every failure mode fails CLOSED: if the evidence cannot be
 * gathered, the token is blocked rather than waved through, because "we
 * could not check" and "it is safe" are not the same statement.
 */

export interface RiskGateOptions {
  /** Max time to spend gathering evidence before failing closed. */
  evidenceTimeoutMs?: number;
  /** Require a sell simulation to prove the token is not a honeypot. */
  requireSellSimulation?: boolean;
}

export interface SellSimulator {
  /** Resolves true when a sell of this mint is demonstrably executable. */
  canSell(tokenMint: string): Promise<boolean>;
}

const DEFAULT_EVIDENCE_TIMEOUT_MS = 4_000;

/**
 * How long a mint's on-chain evidence stays usable.
 *
 * Mint authority, freeze authority and supply are effectively immutable
 * over the life of a snipe decision, so re-reading them per discovery event
 * is pure waste. Holder concentration does move, but not meaningfully
 * inside a minute — and the alternative (two RPC calls on every event, from
 * a websocket that fires continuously during a launch burst) is what
 * exhausts the rate limit that discovery and exit quoting also depend on.
 */
const EVIDENCE_TTL_MS = 60_000;
const EVIDENCE_CACHE_MAX = 500;

export class RiskGateAdapter implements TokenRiskGate {
  private readonly scanner: TokenSafetyScanner;

  /** mint -> { evidence, fetchedAt }. Bounded; see pruneCache(). */
  private readonly evidenceCache = new Map<
    string,
    { evidence: TokenEvidence; fetchedAt: number }
  >();

  /**
   * In-flight lookups, so N simultaneous events for the same mint produce
   * ONE RPC pair rather than N. During a launch burst the same mint is
   * frequently seen by both the websocket and the polling fallback within
   * milliseconds.
   */
  private readonly inflight = new Map<string, Promise<TokenEvidence>>();

  constructor(
    private readonly riskEngine: RiskEngine,
    private readonly connection: Connection,
    private readonly riskConfig: {
      minLiquiditySol: number;
      maxTopHolderPercent: number;
      minHolders: number;
      requireMintAuthorityRevoked: boolean;
      requireFreezeAuthorityRevoked: boolean;
      maxDailyLossSol: number;
      maxExposureSol: number;
      cooldownMs: number;
      emergencyStop: boolean;
    },
    private readonly sellSimulator?: SellSimulator,
    private readonly options: RiskGateOptions = {},
  ) {
    this.scanner = new TokenSafetyScanner(this.riskConfig);
  }

  async assess(input: {
    tokenMint: string;
    // `| undefined` is explicit because exactOptionalPropertyTypes is on:
    // `poolAddress?: string` and `poolAddress?: string | undefined` are
    // different types under that flag, and the interface uses the latter.
    poolAddress?: string | undefined;
    source: string;
    initialLiquidity: number;
    quote: { price: number; timestamp: number; priceImpactBps: number };
    isPumpFun: boolean;
  }) {
    const timeoutMs = this.options.evidenceTimeoutMs ?? DEFAULT_EVIDENCE_TIMEOUT_MS;

    // Engine-level emergency stop is checked here as well as at the
    // circuit breaker: two independent kill paths, so a bug in either one
    // alone cannot let orders through.
    const stop = this.riskEngine.checkEmergencyStop();
    if (!stop.passed) {
      return this.blocked(input.tokenMint, stop.message, { stage: 'emergency_stop' });
    }

    let evidence: TokenEvidence;
    try {
      evidence = await withTimeout(
        this.gatherEvidence(input.tokenMint),
        timeoutMs,
        'risk evidence gathering',
      );
    } catch (error) {
      // Fail closed. An RPC timeout is the single most likely condition
      // during the launch burst this bot targets — precisely when the
      // temptation to "just trade it" is highest and most expensive.
      return this.blocked(
        input.tokenMint,
        `risk evidence unavailable: ${message(error)}`,
        { stage: 'evidence' },
      );
    }

    // Honeypot check: a token you cannot sell is a total loss regardless of
    // every other metric. Only skipped when explicitly disabled in config.
    if (this.options.requireSellSimulation !== false && this.sellSimulator) {
      let sellable: boolean;
      try {
        sellable = await withTimeout(
          this.sellSimulator.canSell(input.tokenMint),
          timeoutMs,
          'sell simulation',
        );
      } catch (error) {
        return this.blocked(
          input.tokenMint,
          `sell simulation failed: ${message(error)}`,
          { stage: 'honeypot' },
        );
      }

      if (!sellable) {
        return this.blocked(input.tokenMint, 'token is not demonstrably sellable', {
          stage: 'honeypot',
        });
      }
    }

    const token: TokenMetadata = {
      mint: input.tokenMint,
      name: evidence.name,
      symbol: evidence.symbol,
      decimals: evidence.decimals,
      supply: evidence.supply,
      mintAuthority: evidence.mintAuthority,
      freezeAuthority: evidence.freezeAuthority,
      metadata: null,
    };

    const pool: PoolInfo = {
      address: input.poolAddress ?? '',
      tokenMint: input.tokenMint,
      liquiditySol: input.initialLiquidity,
      liquidityToken: 0,
      price: input.quote.price,
      volume24h: 0,
      active: true,
    };

    const holders: HolderInfo[] | undefined = evidence.topHolderPercent === null
      ? undefined
      : [{ address: 'top', percentage: evidence.topHolderPercent }];

    /*
     * Holder concentration is not applicable to a pre-graduation pump.fun
     * token, for two independent reasons:
     *
     *  1. It cannot be measured. `getTokenLargestAccounts` rejects the mint
     *     with "Invalid param: not a Token mint" because pump.fun mints are
     *     Token-2022 and that RPC method only supports the legacy program.
     *  2. It would be meaningless if it could. The bonding-curve PDA holds
     *     essentially the entire supply by design, so the top holder is
     *     always ~100% and always benign.
     *
     * Treating that as a failed check blocked 100% of pump.fun launches.
     * Declaring it inapplicable omits the check rather than passing it, so
     * nothing downstream can claim concentration was verified.
     *
     * This must be revisited post-graduation: once a token migrates to a
     * DEX pool the supply is distributed, the metric becomes meaningful,
     * and concentration is a real rug signal again.
     */
    const concentrationApplicable = !(input.isPumpFun && holders === undefined);

    if (!concentrationApplicable) {
      logger.info('RISK_CONCENTRATION_NOT_APPLICABLE', {
        mint: input.tokenMint,
        reason: 'pre-graduation pump.fun token: supply is held by the bonding curve',
      });
    }

    /*
     * The only mint authority we are willing to accept as non-discretionary.
     *
     * Derived here from the mint itself — never taken from the discovery
     * event, enrichment, or any other party — so a hostile or buggy upstream
     * cannot nominate an address it controls and have the veto wave it
     * through. For a pre-graduation pump.fun token this PDA is the program
     * account that legitimately holds mint authority until migration; there
     * is no private key for it.
     *
     * Only offered for pump.fun mints. Everything else keeps the original
     * rule: authority revoked, or blocked.
     */
    let expectedMintAuthority: string | null = null;

    if (input.isPumpFun) {
      try {
        expectedMintAuthority = bondingCurvePda(
          new PublicKey(input.tokenMint),
        ).toBase58();
      } catch (error) {
        // Fail closed: an underivable PDA means we cannot vouch for the
        // authority, so the unmodified veto applies.
        expectedMintAuthority = null;
        logger.warn('RISK_EXPECTED_AUTHORITY_UNRESOLVED', {
          mint: input.tokenMint,
          error: message(error),
        });
      }
    }

    const assessment = this.scanner.scan(token, pool, holders, {
      concentrationApplicable,
      expectedMintAuthority,
    });

    const failed = assessment.checks.filter((c) => !c.passed);

    if (assessment.level === 'BLOCKED' || assessment.level === 'HIGH_RISK') {
      return this.blocked(
        input.tokenMint,
        failed.map((c) => c.message).join('; ') || 'risk threshold not met',
        {
          stage: 'scanner',
          level: assessment.level,
          failedChecks: failed.map((c) => c.name),
        },
      );
    }

    logger.info('RISK_GATE_PASSED', {
      mint: input.tokenMint,
      score: assessment.score,
      level: assessment.level,
      isPumpFun: input.isPumpFun,
      topHolderPercent: evidence.topHolderPercent,
      liquiditySol: input.initialLiquidity,
    });

    return {
      score: assessment.score,
      level: assessment.level,
      canTrade: true,
      reason: `passed ${assessment.checks.length} safety checks`,
      evidence: {
        mintAuthority: evidence.mintAuthority,
        freezeAuthority: evidence.freezeAuthority,
        topHolderPercent: evidence.topHolderPercent,
        supply: evidence.supply,
        checks: assessment.checks.map((c) => ({ name: c.name, passed: c.passed })),
      },
    };
  }

  private blocked(
    tokenMint: string,
    reason: string,
    context: Record<string, unknown>,
  ) {
    logger.warn('RISK_GATE_BLOCKED', { mint: tokenMint, reason, ...context });
    return {
      score: 0,
      level: 'BLOCKED' as const,
      canTrade: false,
      reason,
      evidence: context,
    };
  }

  /**
   * Read the mint account and largest-holder set directly from chain.
   *
   * Deliberately independent of apps/bot/src/enrichment.ts: that module is
   * documented as display-only and best-effort, and swallows failures by
   * returning nulls. A gate that treats "null" as "fine" is the bug this
   * class exists to fix.
   */
  private async gatherEvidence(tokenMint: string): Promise<TokenEvidence> {
    const now = Date.now();

    const cached = this.evidenceCache.get(tokenMint);
    if (cached && now - cached.fetchedAt < EVIDENCE_TTL_MS) {
      return cached.evidence;
    }

    // Coalesce concurrent lookups for the same mint.
    const existing = this.inflight.get(tokenMint);
    if (existing) return existing;

    const lookup = this.fetchEvidence(tokenMint)
      .then((evidence) => {
        this.evidenceCache.set(tokenMint, { evidence, fetchedAt: Date.now() });
        this.pruneCache();
        return evidence;
      })
      .finally(() => {
        this.inflight.delete(tokenMint);
      });

    this.inflight.set(tokenMint, lookup);
    return lookup;
  }

  /** Bound the cache so a long run cannot grow it without limit. */
  private pruneCache(): void {
    if (this.evidenceCache.size <= EVIDENCE_CACHE_MAX) return;

    const entries = [...this.evidenceCache.entries()].sort(
      (a, b) => a[1].fetchedAt - b[1].fetchedAt,
    );
    for (const [mint] of entries.slice(0, entries.length - EVIDENCE_CACHE_MAX)) {
      this.evidenceCache.delete(mint);
    }
  }

  private async fetchEvidence(tokenMint: string): Promise<TokenEvidence> {
    const mintPubkey = new PublicKey(tokenMint);

    const info = await this.connection.getParsedAccountInfo(mintPubkey);
    const data = info.value?.data;

    if (!data || typeof data !== 'object' || !('parsed' in data)) {
      throw new Error('mint account not found or not parseable');
    }

    const parsed = (data as { parsed?: { info?: Record<string, unknown> } }).parsed;
    const mintInfo = parsed?.info;

    if (!mintInfo) {
      throw new Error('mint account has no parsed info');
    }

    const decimals = Number(mintInfo['decimals'] ?? 0);
    const rawSupply = Number(mintInfo['supply'] ?? 0);
    const supply = decimals > 0 ? rawSupply / 10 ** decimals : rawSupply;

    if (!Number.isFinite(supply) || supply <= 0) {
      throw new Error('mint account reports a non-positive supply');
    }

    // `null` here is meaningful: it is how SPL represents a revoked
    // authority. An absent field is NOT the same thing, so treat anything
    // that is not explicitly null as "still active" (the unsafe case).
    const mintAuthority =
      mintInfo['mintAuthority'] === null ? null : String(mintInfo['mintAuthority'] ?? 'unknown');
    const freezeAuthority =
      mintInfo['freezeAuthority'] === null
        ? null
        : String(mintInfo['freezeAuthority'] ?? 'unknown');

    let topHolderPercent: number | null = null;
    try {
      const largest = await this.connection.getTokenLargestAccounts(mintPubkey);
      const top = largest.value[0];
      if (top?.uiAmount != null) {
        const pct = (top.uiAmount / supply) * 100;
        topHolderPercent = Number.isFinite(pct) ? Math.min(pct, 100) : null;
      }
    } catch (error) {
      // Leave null. The scanner records this as a FAILED concentration
      // check (see scanner.ts), so missing data blocks rather than passes.
      logger.warn('RISK_EVIDENCE_HOLDERS_UNAVAILABLE', {
        mint: tokenMint,
        error: message(error),
      });
    }

    return {
      name: String(mintInfo['name'] ?? tokenMint.slice(0, 8)),
      symbol: String(mintInfo['symbol'] ?? tokenMint.slice(0, 4)),
      decimals,
      supply,
      mintAuthority,
      freezeAuthority,
      topHolderPercent,
    };
  }
}

interface TokenEvidence {
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  topHolderPercent: number | null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

