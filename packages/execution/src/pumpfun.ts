
import {
  Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";

// NOTE: @solana/spl-token >= 0.4 is ESM-only, so it cannot be `require()`d from
// this CommonJS package. These two program IDs are protocol constants, and the
// ATA address is a plain PDA derivation â€” both are implemented locally. The only
// remaining spl-token helper (createAssociatedTokenAccountInstruction) is
// dynamically imported inside the async buildSnipeTx.
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

// getAssociatedTokenAddress (SPL reference impl):
//   PDA(seeds=[owner, TOKEN_PROGRAM_ID, mint], programId=ASSOCIATED_TOKEN_PROGRAM_ID)
export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

// All constants verified against pump-fun/pump-public-docs (official, 2026-08).
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_TOKEN_DECIMALS = 6;
export const PUMP_FEE_BPS = 100; // 1% fee on buys/sells

export function isPumpFunToken(tokenMint: string): boolean {
  return typeof tokenMint === 'string' && tokenMint.endsWith('pump');
}

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]); // sha256("global:buy")[0..8] = 0x66063d1201daebea
const GLOBAL_SEED = Buffer.from("global");
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");

// Global state PDA â€” derive at runtime, never hardcode (the published constant has been wrong in the wild).
export function globalPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([GLOBAL_SEED], PUMP_PROGRAM);
  return pda;
}

// Bonding curve PDA â€” seeds are ["bonding-curve", mint], NOT bare [mint].
export function bondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([BONDING_CURVE_SEED, mint.toBuffer()], PUMP_PROGRAM);
  return pda;
}

// Global state layout: discriminator(8) | [initialized(1)] | authority(32) | fee_recipient(32) |
//   initial_virtual_token_reserves(8) | initial_virtual_sol_reserves(8) | fee_basis_points(8) | ...
export interface GlobalState {
  feeRecipient: PublicKey;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  feeBasisPoints: bigint;
}

export function parseGlobal(data: Buffer): GlobalState {
  // Candidate layouts: with/without the `initialized: bool` byte after the discriminator.
  // feeBasisPoints == 100 disambiguates; garbage input throws loudly.
  for (const off of [8 + 1 + 32, 8 + 32]) {
    if (data.length < off + 56) continue;
    const feeBasisPoints = data.readBigUInt64LE(off + 48);
    if (feeBasisPoints !== 100n) continue;
    return {
      feeRecipient: new PublicKey(data.subarray(off, off + 32)),
      virtualTokenReserves: data.readBigUInt64LE(off + 32),
      virtualSolReserves: data.readBigUInt64LE(off + 40),
      feeBasisPoints,
    };
  }
  throw new Error(
    `cannot parse pump.fun global account (feeBasisPoints != 100): ${data.toString("hex")}`,
  );
}

export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
}

export interface BondingCurveState extends CurveState {
  realTokenReserves: bigint;
  realSolReserves: bigint;
  /**
   * Migration/graduation flag. Per the struct layout documented below,
   * this is a single byte immediately after total_supply (offset 120).
   * Only populated when the account data is long enough to include it —
   * older/shorter reads (or an unexpected layout) leave this `undefined`
   * rather than guessing, so callers can distinguish "not graduated" from
   * "couldn't determine."
   *
   * `| undefined` is explicit, not incidental: with
   * `exactOptionalPropertyTypes`, `complete?: boolean` would permit the
   * property to be ABSENT but forbid it being explicitly `undefined` —
   * which is precisely the "couldn't determine" state this field exists to
   * represent. Collapsing that into `false` would tell the graduation
   * poller a token is still on the bonding curve when we simply could not
   * read the byte.
   */
  complete?: boolean | undefined;
}

/*
 * pump.fun BondingCurve account layout.
 *
 *   offset  size  field
 *   ------  ----  -----------------------
 *        0     8  anchor discriminator
 *        8     8  virtual_token_reserves   u64
 *       16     8  virtual_sol_reserves     u64
 *       24     8  real_token_reserves      u64
 *       32     8  real_sol_reserves        u64
 *       40     8  token_total_supply       u64
 *       48     1  complete                 bool
 *       49    32  creator                  pubkey  (added later; optional)
 *
 * Total 49 bytes, or 81 with `creator`.
 *
 * THIS WAS PREVIOUSLY WRONG, and it broke everything downstream. The old
 * version assumed `mint` and `creator` pubkeys sat between the
 * discriminator and the reserves, requiring >= 112 bytes and reading
 * reserves at offsets 80..104. A real account is 49 or 81 bytes, so
 * `parseBondingCurve` threw "data too short" on EVERY read.
 *
 * The damage was silent because callers swallow the throw:
 *   - SimulatedExecutionEngine.getPrice caught it and returned the
 *     hardcoded 0.001 fallback, so every token had an identical, frozen
 *     price. Momentum confirmation then measured 0.00% change forever and
 *     rejected every candidate — the bot could not enter a single trade.
 *   - The graduation poller's `curve?.complete === true` never fired.
 *   - SnipeEngine would have priced live orders off a failed read.
 *
 * A parse error here must never be mistaken for "no price movement", so
 * the errors below are specific enough to tell those cases apart.
 */
const BONDING_CURVE_MIN_LEN = 49;

export function parseBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < BONDING_CURVE_MIN_LEN) {
    throw new Error(
      `pump.fun bonding curve account too short: ${data.length} bytes ` +
        `(expected >= ${BONDING_CURVE_MIN_LEN})`,
    );
  }

  const discriminator = data.subarray(0, 8);
  const expected = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
  if (!discriminator.equals(expected)) {
    throw new Error('invalid bonding curve discriminator');
  }

  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    complete: data.readUInt8(48) === 1,
  };
}

export async function readBondingCurve(conn: Connection, mint: PublicKey): Promise<BondingCurveState | null> {
  const info = await conn.getAccountInfo(bondingCurvePda(mint));
  return info ? parseBondingCurve(info.data as Buffer) : null;
}

// Constant-product curve math: tokensOut = virtualTokenReserves * solInAfterFee / (virtualSolReserves + solInAfterFee)
export function estimateTokensOut(state: CurveState, solInLamports: bigint): bigint {
  const fee = (solInLamports * BigInt(PUMP_FEE_BPS)) / 10_000n;
  const solIn = solInLamports - fee;
  return (state.virtualTokenReserves * solIn) / (state.virtualSolReserves + solIn);
}

export function buildBuyIx(args: {
  mint: PublicKey;
  user: PublicKey;
  feeRecipient: PublicKey;
  tokenAmount: bigint;          // tokens out
  maxSolCostLamports: bigint;   // slippage cap incl. fee
}): TransactionInstruction {
  const { mint, user, feeRecipient, tokenAmount, maxSolCostLamports } = args;
  if (tokenAmount <= 0n) {
    throw new Error('tokenAmount must be positive for pump.fun buy');
  }
  if (maxSolCostLamports <= 0n) {
    throw new Error('maxSolCostLamports must be positive for pump.fun buy');
  }
  const bondingCurve = bondingCurvePda(mint);
  // allowOwnerOffCurve=true is REQUIRED â€” the bonding curve is a PDA, not a signer.
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, user, true);
  const data = Buffer.concat([
    BUY_DISCRIMINATOR,
    u64(tokenAmount),
    u64(maxSolCostLamports),
  ]);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    // Exact account order â€” deviation fails the tx:
    keys: [
      { pubkey: globalPda(), isWritable: false, isSigner: false },
      { pubkey: feeRecipient, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: bondingCurve, isWritable: true, isSigner: false },
      { pubkey: associatedBondingCurve, isWritable: true, isSigner: false },
      { pubkey: associatedUser, isWritable: true, isSigner: false },
      { pubkey: user, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isWritable: false, isSigner: false },
    ],
    data,
  });
}

// pump.fun requires the user's ATA to EXIST before buy â€” create it once per mint.
export async function buildSnipeTx(
  conn: Connection,
  args: {
    mint: PublicKey;
    payer: PublicKey;
    feeRecipient: PublicKey;
    tokenAmount: bigint;
    maxSolCostLamports: bigint;
    blockhash?: string;
  },
): Promise<Transaction> {
  const associatedUser = getAssociatedTokenAddressSync(args.mint, args.payer, true);
  const tx = new Transaction();
  tx.recentBlockhash = args.blockhash ?? (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = args.payer;
  const ata = await conn.getAccountInfo(associatedUser);
  if (!ata) {
    // spl-token is ESM-only; this package is CommonJS, so load it lazily.
    const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
    tx.add(createAssociatedTokenAccountInstruction(args.payer, associatedUser, args.payer, args.mint));
  }
  tx.add(buildBuyIx({ ...args, user: args.payer }));
  return tx;
}

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}