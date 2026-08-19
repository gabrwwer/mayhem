
import { PublicKey } from '@solana/web3.js';

/**
 * Single source of truth for on-chain program ids used across Mayhem.
 *
 * pump.fun bonding-curve program: create + buy + sell all live here.
 * Program ids are immutable; if a protocol ever migrates programs this
 * is the only place that needs updating.
 */
export const PUMP_PROGRAM = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);

/** Raydium AMM v4 (legacy pool program â€” most pump tokens graduate here). */
export const RAYDIUM_AMM_V4 = new PublicKey(
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
);

/** Raydium CPMM (constant-product market maker â€” new pools post AMM migration). */
export const RAYDIUM_CPMM = new PublicKey(
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
);

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * SPL Token program (the original one).
 *
 * This constant exists because the id was previously inlined as a string
 * literal in more than one place and one of those copies was wrong, which
 * silently made token-balance lookups return an empty set. Every caller
 * must import from here; never re-type the base58 by hand.
 */
export const TOKEN_PROGRAM = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/** Token-2022 program (pump.fun mints are Token-2022). */
export const TOKEN_2022_PROGRAM = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

/**
 * Both token programs, in the order balances should be queried.
 * A wallet can hold positions under either program, so any balance or
 * reconciliation path must query both or it will under-report holdings.
 */
export const TOKEN_PROGRAMS: readonly PublicKey[] = [
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
];