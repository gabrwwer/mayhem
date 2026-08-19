import { PublicKeySchema, type PublicKey } from '@mayhem/core-types';
import type { NormalizedPool, PoolInitialization } from '../pool.js';
import { observed, unavailable } from '../provenance.js';
import type { AdapterContext, AdapterResult, PoolAdapter } from './types.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Structural mirror of `BondingCurveState` from
 * `packages/execution/src/pumpfun.ts`.
 *
 * Declared structurally so this package does not depend on
 * `@mayhem/execution` (which pulls in web3.js). The producer —
 * `readBondingCurve` — is unchanged and is NOT reimplemented here.
 *
 * `complete` is `boolean | undefined` exactly as the producer defines it.
 * That `undefined` is load-bearing: it means the account data was too short to
 * contain the graduation byte, which is a different statement from "not
 * graduated". Collapsing it to `false` would tell a caller a token is still on
 * the curve when we could not read it.
 */
export interface BondingCurveStateLike {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  complete?: boolean | undefined;
}

export interface PumpFunObservation {
  tokenMint: string;
  /** Bonding curve PDA, from the existing `bondingCurvePda(mint)`. */
  curveAddress: string;
  /** Quote mint. Wrapped SOL for every pump.fun curve. */
  quoteMint: string;
  curve: BondingCurveStateLike;
  /** Token decimals, needed to render the raw reserve as whole tokens. */
  tokenDecimals: number;
}

function toPublicKey(value: string): PublicKey | null {
  const parsed = PublicKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Convert a raw integer amount to whole units without float intermediates.
 *
 * Division is performed on the bigint, and only the already-scaled result
 * crosses into `number`. Doing `Number(raw) / 10 ** decimals` instead would
 * lose precision on large supplies before the division ever happened.
 */
function toWholeUnits(raw: bigint, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  if (raw < 0n) return null;

  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;

  const value = Number(whole) + Number(remainder) / Number(divisor);
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalizes a pump.fun bonding curve into a pool.
 *
 * A bonding curve is treated as a genuine liquidity venue rather than "no
 * pool": it holds real reserves and is the token's only market until it
 * graduates. Classifying it as pool-less is how a token with observable
 * liquidity ends up reported as having none.
 *
 * Reserves come from `realSolReserves` / `realTokenReserves`, not the virtual
 * figures. The virtual reserves are curve parameters used for pricing, not
 * withdrawable balances — using them as liquidity would overstate how much a
 * pool can actually absorb.
 */
export class PumpFunPoolAdapter implements PoolAdapter<PumpFunObservation> {
  readonly dex = 'pumpfun' as const;

  normalize(raw: PumpFunObservation, context: AdapterContext): AdapterResult {
    const poolAddress = toPublicKey(raw.curveAddress);
    const tokenMint = toPublicKey(raw.tokenMint);
    const quoteMint = toPublicKey(raw.quoteMint);

    if (poolAddress === null || tokenMint === null || quoteMint === null) {
      return {
        ok: false,
        reason:
          'pump.fun observation is missing a valid curve address, token mint or quote mint.',
      };
    }

    const solReserve = toWholeUnits(raw.curve.realSolReserves, 9);
    const tokenReserveValue = toWholeUnits(
      raw.curve.realTokenReserves,
      raw.tokenDecimals,
    );

    if (solReserve === null) {
      return {
        ok: false,
        reason: 'pump.fun realSolReserves could not be rendered as a SOL amount.',
      };
    }

    const source = 'pumpfun-bonding-curve';

    // `complete === undefined` means the byte was unreadable. It maps to
    // UNKNOWN, never to NOT_INITIALIZED — the producer went out of its way to
    // preserve that distinction and flattening it here would discard it.
    const initialization: PoolInitialization =
      raw.curve.complete === undefined
        ? 'UNKNOWN'
        : // A curve holding reserves is an initialized venue whether or not it
          // has graduated. `complete` describes migration to Raydium, not
          // whether the curve itself is live.
          'INITIALIZED';

    const canObserve = context.slot !== null;

    const pool: NormalizedPool = {
      poolAddress,
      tokenMint,
      quoteMint,
      dex: this.dex,
      poolType: 'bonding-curve',

      // A bonding curve holds its balances in the curve account itself; there
      // are no separate vault accounts and no LP mint.
      baseVault: null,
      quoteVault: null,
      lpMint: null,

      tokenReserve:
        canObserve && context.slot !== null && tokenReserveValue !== null
          ? observed(tokenReserveValue, {
              slot: context.slot,
              txSignature: context.txSignature,
              observedAt: context.observedAt,
              source: `${source}:realTokenReserves`,
            })
          : unavailable<number>({
              observedAt: context.observedAt,
              source: `${source}:realTokenReserves`,
            }),

      quoteReserve:
        canObserve && context.slot !== null
          ? observed(solReserve, {
              slot: context.slot,
              txSignature: context.txSignature,
              observedAt: context.observedAt,
              source: `${source}:realSolReserves`,
            })
          : unavailable<number>({
              observedAt: context.observedAt,
              source: `${source}:realSolReserves`,
            }),

      liquidity:
        canObserve && context.slot !== null
          ? observed(solReserve, {
              slot: context.slot,
              txSignature: context.txSignature,
              observedAt: context.observedAt,
              source: `${source}:realSolReserves`,
            })
          : unavailable<number>({
              observedAt: context.observedAt,
              source: `${source}:realSolReserves`,
            }),

      initialization,

      detectedSlot: context.slot,
      initializedSlot: context.witnessedInitialization ? context.slot : null,
      txSignature: context.txSignature,
      observedAt: context.observedAt,
      source,

      // A bonding curve has no LP token to lock or burn. `null` (unknown)
      // rather than `true` — "not applicable" must not read as "verified safe".
      lpLockOrBurnVerified: null,
    };

    return { ok: true, pool };
  }
}
