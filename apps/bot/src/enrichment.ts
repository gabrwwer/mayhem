import { Connection, PublicKey } from '@solana/web3.js';
import { isPumpFunToken, readBondingCurve, bondingCurvePda } from '@mayhem/execution';
import { logger } from './logger';

/**
 * Best-effort, DISPLAY-ONLY token enrichment for the dashboard.
 *
 * This is deliberately independent of the risk-gate / trading decision
 * path (apps/bot/src/risk-gate-adapter.ts). Nothing computed here feeds
 * into whether the bot enters a position — it only makes the dashboard's
 * watchlist show real numbers instead of blanks. If you want enrichment
 * data to influence trading decisions, that's a separate, deliberate
 * change to risk-gate-adapter.ts, not this file.
 *
 * Scope, honestly stated:
 *  - pump.fun tokens: real price + real liquidity, read directly from the
 *    on-chain bonding curve account. No guessing.
 *  - Raydium-sourced tokens: liquidity/price are NOT computed here, and
 *    (see below) holder concentration is skipped too. The Raydium
 *    provider currently discovers pools in "observation-only mode" and
 *    does not forward a poolAddress, so there is no pool to verify
 *    against — returning a liquidity number here would mean fabricating
 *    it. Left null rather than guessed. Skipping the RPC calls entirely
 *    for these also matters operationally: Raydium LP-creation events
 *    fire far more often than pump.fun mints, and every extra RPC call
 *    on an already-rate-limited connection makes the 429 problem worse
 *    for everything else the bot is doing.
 *  - Holder concentration (top-holder %): computed only for pump.fun
 *    tokens via `getTokenLargestAccounts`. Does NOT give a total holder
 *    count (that requires an expensive getProgramAccounts scan this
 *    function deliberately avoids) — `holders` stays null.
 *  - Risk score: a plainly-labeled heuristic (liquidity + concentration),
 *    not a real risk model. Do not treat it as authoritative.
 *
 * Rate-limit handling: every RPC/HTTP call here goes through
 * `withRetry`, which retries on 429s with exponential backoff + jitter
 * and gives up quietly (leaving the field null) rather than retrying
 * forever. This is best-effort enrichment — it must never become a
 * bigger source of RPC load than the discovery pipeline it's annotating.
 */

export interface EnrichmentResult {
  tokenMint: string;
  status?: 'OK' | 'INVALID_TOKEN_MINT' | 'UNSUPPORTED_TOKEN_PROGRAM' | 'RPC_ERROR' | 'TIMEOUT' | 'RATE_LIMITED' | 'SKIPPED';
  /** Token name from pump.fun metadata. Null if the API did not return one. */
  name: string | null;
  /** Ticker from pump.fun metadata. Null if the API did not return one. */
  symbol: string | null;
  /** SOL per token, derived as marketCap / totalSupply. */
  price: number | null;
  /** SOL in the bonding curve (realSolReserves). */
  liquidity: number | null;
  /** Market cap in SOL, to stay consistent with `price`. See usdMarketCap. */
  marketCap: number | null;
  /** Market cap in USD, as reported by pump.fun. Different unit to marketCap. */
  usdMarketCap: number | null;
  /**
   * Total supply in WHOLE TOKENS, already scaled by the mint's decimals.
   *
   * Null when decimals were unavailable. The pump.fun API reports supply in
   * raw base units (1e15 for a standard 1-billion / 6-decimal launch); that
   * raw figure is never surfaced, because a number that large sitting next to
   * a price invites exactly the unit error this field exists to prevent.
   */
  totalSupply: number | null;
  /** Bonding curve PDA — the "pool" for a pre-graduation pump.fun token. */
  poolAddress: string | null;
  /**
   * Holder count. Still null, and deliberately so: an accurate count needs a
   * getProgramAccounts scan (or a DAS-capable provider), which is far more
   * expensive than everything else in this file combined. Guessing from
   * getTokenLargestAccounts would give the top 20, not a count.
   */
  holders: null;
  /**
   * 24h volume. Still null: pump.fun's coins endpoint does not report it and
   * the bot keeps no trade history of its own to derive it from.
   */
  volume24h: null;
  topHolderPercent: number | null;
  riskScore: number | null;
  enrichmentNote: string;
}

/** Parsed subset of the pump.fun coins response. Every field independently optional. */
interface PumpFunMeta {
  name: string | null;
  symbol: string | null;
  /** Market cap in SOL. */
  marketCap: number | null;
  /** Market cap in USD. */
  usdMarketCap: number | null;
  /** RAW base units as returned by the API. Not whole tokens. */
  rawTotalSupply: number | null;
}

const EMPTY_META: PumpFunMeta = {
  name: null,
  symbol: null,
  marketCap: null,
  usdMarketCap: null,
  rawTotalSupply: null,
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || /too many requests/i.test(msg);
}

/** Retry only on rate-limit errors, with exponential backoff + jitter.
 *  Any other error (bad account data, network down, etc.) fails fast —
 *  no point retrying something that isn't a 429. */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label: string; mint: string },
): Promise<T | null> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || i === attempts - 1) break;
      const delay = baseDelayMs * 2 ** i + Math.random() * 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  logger.warn('ENRICHMENT_CALL_FAILED', {
    mint: opts.mint,
    call: opts.label,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    rateLimited: isRateLimitError(lastErr),
  });
  return null;
}

/**
 * Fetch pump.fun coin metadata.
 *
 * This call was already being made; it previously read `market_cap` and
 * `total_supply`, computed a price, and discarded the rest of the response —
 * including the token's name and symbol, which is why every row in the scanner
 * read UNKNOWN with no name. Reading the fields we already paid for costs
 * nothing extra in RPC or API budget.
 *
 * Parsed defensively, field by field: this is a third-party API whose schema
 * is not under our control and is not versioned. A response missing a field
 * yields null for that field only, never a bad value and never a thrown error
 * that loses the fields that did arrive.
 */
async function fetchPumpFunMeta(mint: string): Promise<PumpFunMeta> {
  const meta = await withRetry(
    async (): Promise<PumpFunMeta> => {
      const resp = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
      if (resp.status === 429) throw new Error('429 Too Many Requests');
      if (!resp.ok) return EMPTY_META;

      const data = (await resp.json()) as Record<string, unknown>;

      return {
        name: asNonEmptyString(data['name']),
        symbol: asNonEmptyString(data['symbol']),
        // pump.fun reports `market_cap` in SOL and `usd_market_cap` in USD.
        // They are kept as separate fields rather than one "market cap"
        // because silently mixing the two units in a single column is how a
        // 40 SOL token ends up looking like a $40 token.
        marketCap: asFiniteNumber(data['market_cap']),
        usdMarketCap: asFiniteNumber(data['usd_market_cap']),
        // RAW base units, not whole tokens. A standard pump.fun launch reports
        // 1e15 here: one billion tokens at six decimals. Callers must scale by
        // the mint's decimals before dividing anything by it — see
        // `toWholeSupply` below.
        rawTotalSupply: asFiniteNumber(data['total_supply']),
      };
    },
    { label: 'pumpfun_meta', mint, baseDelayMs: 400 },
  );

  return meta ?? EMPTY_META;
}

/**
 * Convert pump.fun's raw `total_supply` into whole tokens.
 *
 * Returns null when decimals are unknown. That is deliberate: without the
 * scale factor the raw figure is unusable, and guessing six decimals because
 * pump.fun usually mints six would be a fabricated value dressed as a fact.
 * A null price is honest; a price that is wrong by a factor of a million is
 * not, and it is wrong in the direction that makes a token look absurdly
 * cheap.
 */
function toWholeSupply(
  rawTotalSupply: number | null,
  decimals: number | undefined,
): number | null {
  if (rawTotalSupply === null || rawTotalSupply <= 0) return null;
  if (decimals === undefined || !Number.isInteger(decimals)) return null;
  if (decimals < 0 || decimals > 18) return null;

  const whole = rawTotalSupply / 10 ** decimals;
  return Number.isFinite(whole) && whole > 0 ? whole : null;
}

/**
 * Top-holder concentration as a percentage of supply.
 *
 * `wholeSupply` must be in whole tokens, because `getTokenLargestAccounts`
 * returns `uiAmount`, which is already decimal-adjusted. Passing the raw
 * supply here divides a UI amount by a base-unit amount and yields a
 * concentration near zero for every token — i.e. it reports every token as
 * perfectly distributed, which is the most dangerous possible wrong answer
 * for this particular metric.
 */
export async function validateTokenMintForHolderLookup(
  connection: Connection,
  mint: string,
): Promise<{ valid: boolean; reason?: 'INVALID_TOKEN_MINT' | 'UNSUPPORTED_TOKEN_PROGRAM'; programId?: string }> {
  try {
    const publicKey = new PublicKey(mint);
    const accountInfo = await withRetry(
      () => connection.getParsedAccountInfo(publicKey),
      { label: 'mint_account_validation', mint, baseDelayMs: 250 },
    );

    if (!accountInfo || !accountInfo.value) {
      return { valid: false, reason: 'INVALID_TOKEN_MINT' };
    }

    const data = accountInfo.value.data;
    if (!data || typeof data !== 'object' || !('parsed' in data)) {
      return { valid: false, reason: 'INVALID_TOKEN_MINT' };
    }

    const parsed = (data as { parsed?: { info?: Record<string, unknown> } }).parsed;
    const mintInfo = parsed?.info;
    if (!mintInfo || mintInfo['type'] !== 'mint') {
      return { valid: false, reason: 'INVALID_TOKEN_MINT' };
    }

    const programId = (data as { program?: string | PublicKey }).program;
    const programValue = typeof programId === 'string' ? programId : programId?.toBase58?.();

    // `getTokenLargestAccounts()` is legacy-token-only. Token-2022 mints are
    // valid SPL mints, but they are not supported by this RPC method, so they
    // must be rejected before we call it.
    const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

    if (programValue === TOKEN_2022_PROGRAM) {
      return { valid: false, reason: 'UNSUPPORTED_TOKEN_PROGRAM', programId: programValue };
    }

    if (programValue && programValue !== LEGACY_TOKEN_PROGRAM) {
      return { valid: false, reason: 'INVALID_TOKEN_MINT', programId: programValue };
    }

    if (!programValue) {
      return { valid: false, reason: 'INVALID_TOKEN_MINT' };
    }

    return { valid: true, programId: programValue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('ENRICHMENT_MINT_VALIDATION_FAILED', {
      mint,
      status: 'INVALID_TOKEN_MINT',
      reason: 'INVALID_TOKEN_MINT',
      error: message,
    });
    return { valid: false, reason: 'INVALID_TOKEN_MINT' };
  }
}

async function getTopHolderPercent(
  connection: Connection,
  mint: string,
  wholeSupply: number | null,
): Promise<number | null> {
  if (wholeSupply === null || wholeSupply <= 0) return null;

  const validation = await validateTokenMintForHolderLookup(connection, mint);
  if (!validation.valid) {
    logger.warn('ENRICHMENT_INVALID_TOKEN_MINT', {
      mint,
      status: validation.reason ?? 'INVALID_TOKEN_MINT',
      reason: validation.reason ?? 'INVALID_TOKEN_MINT',
      programId: validation.programId ?? null,
    });
    return null;
  }

  return withRetry(
    async () => {
      const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
      const top = largest.value[0];
      if (!top || top.uiAmount === null || top.uiAmount === undefined) return null;
      const pct = (top.uiAmount / wholeSupply) * 100;
      return Number.isFinite(pct) ? Math.min(pct, 100) : null;
    },
    { label: 'top_holder_percent', mint, baseDelayMs: 500 },
  );
}

async function getBondingCurveLiquidity(
  connection: Connection,
  mint: string,
): Promise<number | null> {
  const curve = await withRetry(
    () => readBondingCurve(connection, new PublicKey(mint)),
    { label: 'bonding_curve', mint, baseDelayMs: 500 },
  );
  return curve ? Number(curve.realSolReserves) / 1e9 : null;
}

/**
 * Naive, clearly-heuristic safety score (0-100, higher = safer). Never
 * presented as anything more than a rough display signal.
 *
 * One behaviour is deliberate and worth understanding before changing it:
 * **a missing input must not read as an absent risk.**
 *
 * Previously a token with deep liquidity but unknown holder concentration
 * scored 75 — the same as a token verified to be well distributed — because
 * the concentration penalty simply never ran. That is the wrong direction to
 * fail in: it makes a token where one wallet may hold 90% of supply look as
 * safe as one where nobody does. The score is now capped whenever a
 * risk-revealing input could not be read, so an unmeasured token can never
 * present as strongly safe.
 */
const UNKNOWN_CONCENTRATION_CAP = 60;

function heuristicRiskScore(
  liquidity: number | null,
  topHolderPercent: number | null,
): number | null {
  if (liquidity === null && topHolderPercent === null) return null;

  let score = 50;

  if (liquidity !== null) {
    score += liquidity >= 10 ? 25 : liquidity >= 1 ? 10 : -15;
  }

  if (topHolderPercent !== null) {
    score -= topHolderPercent >= 50 ? 30 : topHolderPercent >= 25 ? 15 : 0;
  } else {
    // Concentration is the single largest downside risk this heuristic can
    // see. Without it, refuse to certify anything above "unremarkable".
    score = Math.min(score, UNKNOWN_CONCENTRATION_CAP);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * `event` is structurally a `TokenDiscoveryEvent`, which already carries
 * `decimals` and a whole-token `supply`. Both are read here rather than
 * re-fetched: the mint account has already been decoded once by discovery, and
 * `decimals` is required to interpret pump.fun's raw supply figure at all.
 */
export async function enrichToken(
  connection: Connection,
  event: { tokenMint: string; supply?: number; decimals?: number },
): Promise<EnrichmentResult> {
  const mint = event.tokenMint;
  const isPumpFun = isPumpFunToken(mint);

  if (!isPumpFun) {
    // Raydium-sourced: no verified pool to read, and not worth spending
    // RPC budget on holder-lookup for tokens the risk gate is going to
    // reject anyway (see risk-gate-adapter.ts — unverified pools are
    // always blocked). Return immediately, no network calls at all.
    return {
      tokenMint: mint,
      status: 'SKIPPED',
      name: null,
      symbol: null,
      price: null,
      liquidity: null,
      marketCap: null,
      usdMarketCap: null,
      totalSupply: null,
      poolAddress: null,
      holders: null,
      volume24h: null,
      topHolderPercent: null,
      riskScore: null,
      enrichmentNote:
        'Raydium-sourced token: enrichment skipped — pool is in observation-only mode ' +
        '(no verified pool address), and this token is blocked by the risk gate regardless.',
    };
  }

  // Small jitter so a burst of simultaneous discoveries doesn't fire a
  // synchronized wall of RPC calls; spreads load over ~0-1.5s.
  await new Promise((r) => setTimeout(r, Math.random() * 1500));

  // Metadata first: its supply is what makes top-holder concentration
  // computable. The previous code passed `event.supply`, which the SPL
  // discovery provider does not populate, so getTopHolderPercent returned null
  // on its first guard for every token and the RPC call was never even made.
  const meta = await fetchPumpFunMeta(mint);

  // Everything downstream works in whole tokens. `event.supply` is already a
  // whole-token figure (TokenDiscoveryEvent carries `supplyRaw` separately for
  // the base-unit value), so it needs no scaling; the API's figure does.
  const wholeSupply =
    toWholeSupply(meta.rawTotalSupply, event.decimals) ?? event.supply ?? null;

  let mintValidation: { valid: boolean; reason?: 'INVALID_TOKEN_MINT' | 'UNSUPPORTED_TOKEN_PROGRAM'; programId?: string } | null = null;
  if (wholeSupply !== null && wholeSupply > 0) {
    mintValidation = await validateTokenMintForHolderLookup(connection, mint);
  }

  const [liquidity, topHolderPercent] = await Promise.all([
    getBondingCurveLiquidity(connection, mint),
    mintValidation && mintValidation.valid ? getTopHolderPercent(connection, mint, wholeSupply) : Promise.resolve(null),
  ]);

  const tokenStatus = mintValidation && !mintValidation.valid
    ? mintValidation.reason === 'UNSUPPORTED_TOKEN_PROGRAM'
      ? 'UNSUPPORTED_TOKEN_PROGRAM'
      : 'INVALID_TOKEN_MINT'
    : 'OK';

  // Price in SOL per whole token. Derived rather than read from a price field
  // so it stays consistent with the market cap shown beside it.
  //
  // Both operands must be in matching units. Dividing SOL market cap by the
  // API's raw base-unit supply — which is what this did previously — under-
  // states the price by 10^decimals, i.e. a factor of one million on a typical
  // pump.fun mint.
  const price =
    meta.marketCap !== null && wholeSupply !== null && wholeSupply > 0
      ? meta.marketCap / wholeSupply
      : null;

  const riskScore = heuristicRiskScore(liquidity, topHolderPercent);

  // The bonding curve PDA is this token's pool while it is pre-graduation.
  // Derived locally from the mint — no network call, and deterministic.
  let poolAddress: string | null = null;
  try {
    poolAddress = bondingCurvePda(new PublicKey(mint)).toBase58();
  } catch (err) {
    logger.warn('ENRICHMENT_POOL_DERIVE_FAILED', {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    tokenMint: mint,
    status: tokenStatus,
    name: meta.name,
    symbol: meta.symbol,
    price,
    liquidity,
    marketCap: meta.marketCap,
    usdMarketCap: meta.usdMarketCap,
    totalSupply: wholeSupply,
    poolAddress,
    holders: null,
    volume24h: null,
    topHolderPercent,
    riskScore,
    enrichmentNote:
      'pump.fun: name/symbol/market cap from coins API. Price = SOL market cap / supply in ' +
      'WHOLE tokens (API supply is raw base units and is scaled by mint decimals first). ' +
      'Liquidity = bonding curve realSolReserves (SOL). Top-holder % compares uiAmount against ' +
      'whole-token supply. Safety score is a heuristic, higher = safer. Holder count and 24h ' +
      'volume have no data source.',
  };
}
