import { PublicKeySchema, type PublicKey } from '@mayhem/core-types';
import type { NormalizedPool, PoolType } from '../pool.js';
import { observed, unavailable } from '../provenance.js';
import type { AdapterContext, AdapterResult, PoolAdapter } from './types.js';

/**
 * Structural mirror of `VerifiedRaydiumPool` from
 * `packages/token-monitor/src/raydium-pool-verifier.ts`.
 *
 * Declared structurally rather than imported so `@mayhem/lp-intelligence`
 * stays dependency-free of `@mayhem/token-monitor`. token-monitor pulls in
 * `@solana/web3.js` and the Raydium SDK; this package is pure logic and must
 * remain importable by tests with no chain dependencies at all.
 *
 * The producer is unchanged and is NOT reimplemented here — the caller runs
 * `RaydiumPoolVerifier.verifyPool()` and hands the result to this adapter.
 * Any field added there will simply be ignored here until it is mapped.
 */
export interface RaydiumVerifiedPoolLike {
  poolType: 'amm-v4' | 'cpmm';
  programId: string;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  lpMint: string;
  /** Quote-side reserve in whole SOL, as decoded from the quote vault. */
  quoteReserveSol: number;
  poolVerifiedAtMs: number;
}

function toPublicKey(value: string): PublicKey | null {
  const parsed = PublicKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Normalizes a verified Raydium pool.
 *
 * Two honest limitations, both surfaced as UNAVAILABLE rather than papered
 * over:
 *
 *  - **Token reserve is not reported.** `RaydiumPoolVerifier` decodes the
 *    quote vault balance only. Inferring the base reserve from the quote side
 *    would require a price this package does not have.
 *  - **LP lock/burn is never claimed.** The verifier returns an `lpMint` but
 *    performs no supply or lock-program inspection, so `lpLockOrBurnVerified`
 *    stays null. Reporting an unverified LP as locked is the single most
 *    dangerous thing this adapter could do.
 *
 * `liquidity` is set equal to the observed quote reserve, in SOL. That is a
 * one-sided measure, not a full TVL, and is labelled as such in `source`.
 */
export class RaydiumPoolAdapter implements PoolAdapter<RaydiumVerifiedPoolLike> {
  readonly dex = 'raydium' as const;

  normalize(raw: RaydiumVerifiedPoolLike, context: AdapterContext): AdapterResult {
    const poolAddress = toPublicKey(raw.poolAddress);
    const tokenMint = toPublicKey(raw.baseMint);
    const quoteMint = toPublicKey(raw.quoteMint);

    if (poolAddress === null || tokenMint === null || quoteMint === null) {
      return {
        ok: false,
        reason:
          'Raydium pool is missing a valid pool address, base mint or quote mint.',
      };
    }

    if (!Number.isFinite(raw.quoteReserveSol) || raw.quoteReserveSol < 0) {
      return {
        ok: false,
        reason: `Raydium quote reserve is not a usable number: ${String(raw.quoteReserveSol)}.`,
      };
    }

    const source = `raydium-pool-verifier:${raw.poolType}`;

    // A decoded vault balance with no slot cannot be ordered against later
    // readings or reconciled after a reorg, so it does not qualify as an
    // on-chain observation. Recorded as unavailable rather than downgraded to
    // an estimate, because we are not estimating — we simply cannot place it.
    const quoteReserve =
      context.slot === null
        ? unavailable<number>({ observedAt: context.observedAt, source })
        : observed(raw.quoteReserveSol, {
            slot: context.slot,
            txSignature: context.txSignature,
            observedAt: context.observedAt,
            source: `${source}:quote-vault`,
          });

    const pool: NormalizedPool = {
      poolAddress,
      tokenMint,
      quoteMint,
      dex: this.dex,
      poolType: raw.poolType satisfies PoolType,
      baseVault: toPublicKey(raw.baseVault),
      quoteVault: toPublicKey(raw.quoteVault),
      lpMint: toPublicKey(raw.lpMint),

      // The verifier does not decode the base vault balance.
      tokenReserve: unavailable<number>({
        observedAt: context.observedAt,
        source: `${source}:base-vault-not-decoded`,
      }),
      quoteReserve,
      liquidity:
        context.slot === null
          ? unavailable<number>({ observedAt: context.observedAt, source })
          : observed(raw.quoteReserveSol, {
              slot: context.slot,
              txSignature: context.txSignature,
              observedAt: context.observedAt,
              source: `${source}:quote-side-only`,
            }),

      // Verification succeeded, so the venue considers the pool live.
      initialization: 'INITIALIZED',

      detectedSlot: context.slot,
      initializedSlot: context.witnessedInitialization ? context.slot : null,
      txSignature: context.txSignature,
      observedAt: context.observedAt,
      source,
      lpLockOrBurnVerified: null,
    };

    return { ok: true, pool };
  }
}
