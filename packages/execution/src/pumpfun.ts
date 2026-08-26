// The execution package can be type-checked independently of the workspace
// dependency installation. These declarations keep this module self-contained
// for that case; the actual Solana packages are still used at runtime.
declare const Buffer: any;
type Buffer = any;

// @ts-ignore The dependency is provided by the consuming workspace.
import { AccountMeta, Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
): PublicKey {
  void allowOwnerOffCurve;
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export function getAssociatedTokenAddressForProgram(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export function isSupportedPumpFunTokenProgram(program: PublicKey): boolean {
  return program.equals(TOKEN_PROGRAM_ID);
}

/*
 * Source: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 * Verified: pump.fun V2 official IDL
 */
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_TOKEN_DECIMALS = 6;
export const PUMP_FEE_BPS = 100; // 1% fee on buys/sells

/*
 * Source: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 * Verified: pump.fun V2 official IDL
 */
export const BUY_DISCRIMINATOR_V2 = Buffer.from([184, 23, 238, 97, 103, 197, 211, 61]);
export const SELL_DISCRIMINATOR_V2 = Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]);
export const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const BONDING_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
export const GLOBAL_DISCRIMINATOR = Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]);

export function isPumpFunToken(tokenMint: string): boolean {
  return typeof tokenMint === 'string' && tokenMint.endsWith('pump');
}

// Bonding curve PDA seeds: ["bonding-curve", mint]
export function bondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM,
  );
  return pda;
}

// Global state PDA seeds: ["global"]
export function globalPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_PROGRAM,
  );
  return pda;
}

// Creator vault PDA seeds: ["creator-vault", creator]
export function creatorVaultPda(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMP_PROGRAM,
  );
  return pda;
}

// User volume accumulator PDA seeds: ["user_volume_accumulator", user]
export function userVolumeAccumulatorPda(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    PUMP_PROGRAM,
  );
  return pda;
}

const FEE_CONFIG_SEED = Buffer.from("fee_config");
const SHARING_CONFIG_SEED = Buffer.from("sharing-config");
const GLOBAL_VOLUME_ACCUMULATOR_SEED = Buffer.from("global_volume_accumulator");

export function globalVolumeAccumulatorPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [GLOBAL_VOLUME_ACCUMULATOR_SEED],
    PUMP_PROGRAM,
  );
  return pda;
}

export function feeConfigPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [FEE_CONFIG_SEED, PUMP_PROGRAM.toBuffer()],
    PUMP_PROGRAM,
  );
  return pda;
}

export function sharingConfigPda(baseMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SHARING_CONFIG_SEED, baseMint.toBuffer()],
    FEE_PROGRAM,
  );
  return pda;
}

// Event authority PDA seeds: ["__event_authority"]
export function eventAuthorityPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP_PROGRAM,
  );
  return pda;
}

// BondingCurve layout from the current pump.fun account definition:
// discriminator | five u64 reserves/supply | complete | creator |
// is_mayhem_mode | is_cashback_coin | quote_mint.
const BONDING_CURVE_LENGTH = 115;
export interface BondingCurveState {
  discriminator: Uint8Array;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  tokenMint: PublicKey;
  creator: PublicKey;
  complete: boolean;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
}

export function parseBondingCurve(data: Buffer): BondingCurveState {
  if (data.length !== BONDING_CURVE_LENGTH) {
    throw new Error(
      `BondingCurve data has unsupported layout: expected ${BONDING_CURVE_LENGTH} bytes, got ${data.length}`,
    );
  }

  // Discriminator (0-7)
  const discriminator = data.slice(0, 8);
  if (!discriminator.equals(BONDING_CURVE_DISCRIMINATOR)) {
    throw new Error("Invalid pump.fun bonding curve discriminator");
  }

  // Virtual reserves (8-23)
  const virtualTokenReserves = readU64(data, 8);
  const virtualSolReserves = readU64(data, 16);

  const realTokenReserves = readU64(data, 24);
  const realSolReserves = readU64(data, 32);
  const tokenTotalSupply = readU64(data, 40);
  if (data[48] !== 0 && data[48] !== 1) {
    throw new Error("Invalid pump.fun bonding curve complete flag");
  }
  const complete = data[48] !== 0;
  if (
    (data[81] !== 0 && data[81] !== 1) ||
    (data[82] !== 0 && data[82] !== 1)
  ) {
    throw new Error("Invalid pump.fun bonding curve boolean flags");
  }
  const creator = new PublicKey(data.slice(49, 81));
  const isMayhemMode = data[81] !== 0;
  const isCashbackCoin = data[82] !== 0;
  const quoteMint = new PublicKey(data.slice(83, 115));

  return {
    discriminator,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    tokenMint: PublicKey.default,
    creator,
    complete,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
  };
}

function readU64(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

export async function readBondingCurve(conn: Connection, mint: PublicKey): Promise<BondingCurveState | null> {
  const info = await conn.getAccountInfo(bondingCurvePda(mint));
  if (!info) return null;
  const state = parseBondingCurve(info.data as Buffer);
  state.tokenMint = mint;
  return state;
}

// Constant-product curve math: tokensOut = virtualTokenReserves * solInAfterFee / (virtualSolReserves + solInAfterFee)
export function estimateTokensOut(state: BondingCurveState, solInLamports: bigint): bigint {
  const fee = (solInLamports * BigInt(PUMP_FEE_BPS)) / 10_000n;
  const solIn = solInLamports - fee;
  return (state.virtualTokenReserves * solIn) / (state.virtualSolReserves + solIn);
}

// Global state layout: discriminator(8) | [initialized(1)] | authority(32) | fee_recipient(32) |
//   initial_virtual_token_reserves(8) | initial_virtual_sol_reserves(8) | fee_basis_points(8) | ...
export interface GlobalState {
  feeRecipient: PublicKey;
  feeRecipients: PublicKey[];
  reservedFeeRecipient: PublicKey;
  reservedFeeRecipients: PublicKey[];
  buybackFeeRecipients: PublicKey[];
  mayhemModeEnabled: boolean;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  feeBasisPoints: bigint;
  creatorFeeBasisPoints: bigint;
}

export const CURRENT_BUYBACK_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
] as const;

export function parseGlobal(data: Buffer): GlobalState {
  const expectedLength = 1045;
  if (data.length !== expectedLength) {
    throw new Error(
      `Unsupported pump.fun global account layout: expected ${expectedLength} bytes, got ${data.length}`,
    );
  }
  if (!data.subarray(0, 8).equals(GLOBAL_DISCRIMINATOR)) {
    throw new Error("Invalid pump.fun global discriminator");
  }
  if (data[8] !== 0 && data[8] !== 1) {
    throw new Error("Invalid pump.fun global initialized flag");
  }
  const boolAt = (offset: number, name: string): boolean => {
    if (data[offset] !== 0 && data[offset] !== 1) {
      throw new Error(`Invalid pump.fun global ${name} flag`);
    }
    return data[offset] !== 0;
  };
  const pubkeyAt = (offset: number): PublicKey =>
    new PublicKey(data.subarray(offset, offset + 32));
  const arrayAt = (offset: number, count: number): PublicKey[] =>
    Array.from({ length: count }, (_, index) => pubkeyAt(offset + index * 32));

  const feeBasisPoints = data.readBigUInt64LE(105);
  if (feeBasisPoints <= 0n) {
    throw new Error("Invalid pump.fun fee basis points");
  }
  return {
    feeRecipient: pubkeyAt(41),
    feeRecipients: arrayAt(162, 7),
    reservedFeeRecipient: pubkeyAt(483),
    reservedFeeRecipients: arrayAt(516, 7),
    buybackFeeRecipients: arrayAt(741, 8),
    mayhemModeEnabled: boolAt(515, "mayhem mode"),
    virtualTokenReserves: data.readBigUInt64LE(73),
    virtualSolReserves: data.readBigUInt64LE(81),
    feeBasisPoints,
    creatorFeeBasisPoints: data.readBigUInt64LE(154),
  };
}

export interface ResolvedFeeRecipients {
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

export function resolveFeeRecipients(
  global: GlobalState,
  mayhemMode: boolean,
): ResolvedFeeRecipients {
  const feeRecipients = mayhemMode
    ? [global.reservedFeeRecipient, ...global.reservedFeeRecipients]
    : [global.feeRecipient, ...global.feeRecipients];
  const feeRecipient = feeRecipients.find((value) => !value.equals(PublicKey.default));
  if (!feeRecipient) {
    throw new Error("pump.fun fee recipient set is empty");
  }

  const buybackFeeRecipient = global.buybackFeeRecipients.find(
    (value) => !value.equals(PublicKey.default),
  );
  if (!buybackFeeRecipient) {
    throw new Error("pump.fun buyback fee recipient set is empty");
  }

  return { feeRecipient, buybackFeeRecipient };
}

export interface PumpFunV2Accounts {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
  user: PublicKey;
  creator: PublicKey;
}

function meta(
  pubkey: PublicKey,
  isWritable = false,
  isSigner = false,
): AccountMeta {
  return { pubkey, isWritable, isSigner };
}

function encodeU64(value: bigint, name: string): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${name} must fit in u64`);
  }
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(value);
  return encoded;
}

function v2AccountMetas(accounts: PumpFunV2Accounts): AccountMeta[] {
  if (
    !isSupportedPumpFunTokenProgram(accounts.baseTokenProgram) ||
    !isSupportedPumpFunTokenProgram(accounts.quoteTokenProgram)
  ) {
    throw new Error(
      "unsupported_token_program: pump.fun V2 execution requires the classic SPL Token program",
    );
  }
  const curve = bondingCurvePda(accounts.baseMint);
  const creatorVault = creatorVaultPda(accounts.creator);
  const userVolumeAccumulator = userVolumeAccumulatorPda(accounts.user);
  const associated = (mint: PublicKey, owner: PublicKey, program: PublicKey) =>
    getAssociatedTokenAddressForProgram(mint, owner, program);

  return [
    meta(globalPda()),
    meta(accounts.baseMint),
    meta(accounts.quoteMint),
    meta(accounts.baseTokenProgram),
    meta(accounts.quoteTokenProgram),
    meta(ASSOCIATED_TOKEN_PROGRAM_ID),
    meta(accounts.feeRecipient, true),
    meta(associated(accounts.quoteMint, accounts.feeRecipient, accounts.quoteTokenProgram), true),
    meta(accounts.buybackFeeRecipient, true),
    meta(associated(accounts.quoteMint, accounts.buybackFeeRecipient, accounts.quoteTokenProgram), true),
    meta(curve, true),
    meta(associated(accounts.baseMint, curve, accounts.baseTokenProgram), true),
    meta(associated(accounts.quoteMint, curve, accounts.quoteTokenProgram), true),
    meta(accounts.user, true, true),
    meta(associated(accounts.baseMint, accounts.user, accounts.baseTokenProgram), true),
    meta(associated(accounts.quoteMint, accounts.user, accounts.quoteTokenProgram), true),
    meta(creatorVault, true),
    meta(associated(accounts.quoteMint, creatorVault, accounts.quoteTokenProgram), true),
    meta(sharingConfigPda(accounts.baseMint)),
    meta(globalVolumeAccumulatorPda()),
    meta(userVolumeAccumulator, true),
    meta(associated(accounts.quoteMint, userVolumeAccumulator, accounts.quoteTokenProgram), true),
    meta(feeConfigPda()),
    meta(FEE_PROGRAM),
    meta(SystemProgram.programId),
    meta(eventAuthorityPda()),
    meta(PUMP_PROGRAM),
  ];
}

export function buildBuyV2Ix(
  accounts: PumpFunV2Accounts,
  args: { amount: bigint; maxSolCost: bigint },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: v2AccountMetas(accounts),
    data: Buffer.concat([
      BUY_DISCRIMINATOR_V2,
      encodeU64(args.amount, "amount"),
      encodeU64(args.maxSolCost, "maxSolCost"),
    ]),
  });
}

export function buildSellV2Ix(
  accounts: PumpFunV2Accounts,
  args: { amount: bigint; minSolOutput: bigint },
): TransactionInstruction {
  const keys = v2AccountMetas(accounts).filter((_, index) => index !== 19);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys,
    data: Buffer.concat([
      SELL_DISCRIMINATOR_V2,
      encodeU64(args.amount, "amount"),
      encodeU64(args.minSolOutput, "minSolOutput"),
    ]),
  });
}

export function buildBuyIx(
  user: PublicKey,
  userTokenAccount: PublicKey,
  bondingCurve: PublicKey,
  bondingCurveVault: PublicKey,
  tokenMint: PublicKey,
  global: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  systemProgram: PublicKey = SystemProgram.programId,
  rent: PublicKey = SYSVAR_RENT_PUBKEY,
  eventAuthority: PublicKey,
  program: PublicKey = PUMP_PROGRAM,
  args: {
    tokenAmount: bigint;
    maxSolCost: bigint;
  }
): TransactionInstruction {
  void [
    user, userTokenAccount, bondingCurve, bondingCurveVault, tokenMint, global,
    tokenProgram, systemProgram, rent, eventAuthority, program, args,
  ];
  throw new Error(
    "pump.fun live BUY construction is disabled: authoritative account layout is not available",
  );
}

export function buildSellIx(
  user: PublicKey,
  userTokenAccount: PublicKey,
  bondingCurve: PublicKey,
  bondingCurveVault: PublicKey,
  tokenMint: PublicKey,
  global: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  systemProgram: PublicKey = SystemProgram.programId,
  rent: PublicKey = SYSVAR_RENT_PUBKEY,
  eventAuthority: PublicKey,
  program: PublicKey = PUMP_PROGRAM,
  args: {
    tokenAmount: bigint;
    minSolOutput: bigint;
  }
): TransactionInstruction {
  void [
    user, userTokenAccount, bondingCurve, bondingCurveVault, tokenMint, global,
    tokenProgram, systemProgram, rent, eventAuthority, program, args,
  ];
  throw new Error(
    "pump.fun live SELL construction is disabled: authoritative account layout is not available",
  );
}

// pump.fun requires the user's ATA to EXIST before buy â€” create it once per mint.
export async function buildSnipeTx(
  conn: Connection,
  args: {
    mint: PublicKey;
    payer: PublicKey;
    feeRecipient: PublicKey;
    buybackFeeRecipient: PublicKey;
    tokenAmount: bigint;
    maxSolCostLamports: bigint;
    blockhash?: string;
  },
): Promise<Transaction> {
  const curve = await readBondingCurve(conn, args.mint);
  if (!curve) throw new Error("pump.fun bonding curve not found");
  if (!isSupportedPumpFunTokenProgram(TOKEN_PROGRAM_ID)) {
    throw new Error("unsupported_token_program");
  }
  const globalInfo = await conn.getAccountInfo(globalPda());
  if (!globalInfo) throw new Error("pump.fun global account not found");
  const global = parseGlobal(globalInfo.data as Buffer);
  const recipients = resolveFeeRecipients(global, curve.isMayhemMode);
  if (!args.feeRecipient.equals(recipients.feeRecipient)) {
    throw new Error("fee_recipient_mismatch");
  }
  if (!args.buybackFeeRecipient.equals(recipients.buybackFeeRecipient)) {
    throw new Error("buyback_fee_recipient_mismatch");
  }

  const associatedUser = getAssociatedTokenAddressSync(args.mint, args.payer, true);
  const tx = new Transaction();
  tx.recentBlockhash = args.blockhash ?? (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = args.payer;
  const ata = await conn.getAccountInfo(associatedUser);
  if (!ata) {
    const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
    tx.add(createAssociatedTokenAccountInstruction(
      args.payer,
      associatedUser,
      args.payer,
      args.mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }
  tx.add(buildBuyV2Ix({
    baseMint: args.mint,
    quoteMint: curve.quoteMint.equals(PublicKey.default) ? WSOL_MINT : curve.quoteMint,
    baseTokenProgram: TOKEN_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    feeRecipient: recipients.feeRecipient,
    buybackFeeRecipient: recipients.buybackFeeRecipient,
    user: args.payer,
    creator: curve.creator,
  }, {
    amount: args.tokenAmount,
    maxSolCost: args.maxSolCostLamports,
  }));
  return tx;
}

// Build a pump.fun sell transaction (V2)
export async function buildSellTx(
  conn: Connection,
  args: {
    mint: PublicKey;
    payer: PublicKey;
    feeRecipient: PublicKey;
    buybackFeeRecipient: PublicKey;
    tokenAmount: bigint;
    minSolOutputLamports: bigint;
    blockhash?: string;
  },
): Promise<Transaction> {
  const curve = await readBondingCurve(conn, args.mint);
  if (!curve) throw new Error("pump.fun bonding curve not found");
  if (curve.complete) throw new Error("pump.fun bonding curve graduated");
  const globalInfo = await conn.getAccountInfo(globalPda());
  if (!globalInfo) throw new Error("pump.fun global account not found");
  const global = parseGlobal(globalInfo.data as Buffer);
  const recipients = resolveFeeRecipients(global, curve.isMayhemMode);
  if (!args.feeRecipient.equals(recipients.feeRecipient)) {
    throw new Error("fee_recipient_mismatch");
  }
  if (!args.buybackFeeRecipient.equals(recipients.buybackFeeRecipient)) {
    throw new Error("buyback_fee_recipient_mismatch");
  }

  const associatedUser = getAssociatedTokenAddressSync(args.mint, args.payer, true);
  const ataInfo = await conn.getAccountInfo(associatedUser);
  if (!ataInfo) {
    throw new Error("user ATA does not exist");
  }
  if (!ataInfo.owner.equals(TOKEN_PROGRAM_ID) || ataInfo.data.length < 165) {
    throw new Error("user ATA is not a valid classic SPL account");
  }
  const balance = ataInfo.data.readBigUInt64LE(64);
  if (balance < BigInt(args.tokenAmount)) throw new Error("insufficient token balance");

  const tx = new Transaction();
  tx.recentBlockhash = args.blockhash ?? (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = args.payer;
  tx.add(buildSellV2Ix({
    baseMint: args.mint,
    quoteMint: curve.quoteMint.equals(PublicKey.default) ? WSOL_MINT : curve.quoteMint,
    baseTokenProgram: TOKEN_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    feeRecipient: recipients.feeRecipient,
    buybackFeeRecipient: recipients.buybackFeeRecipient,
    user: args.payer,
    creator: curve.creator,
  }, {
    amount: args.tokenAmount,
    minSolOutput: args.minSolOutputLamports,
  }));
  return tx;
}