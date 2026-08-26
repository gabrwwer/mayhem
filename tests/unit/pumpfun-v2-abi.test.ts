import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BUY_DISCRIMINATOR_V2,
  FEE_PROGRAM,
  PUMP_PROGRAM,
  SELL_DISCRIMINATOR_V2,
  TOKEN_PROGRAM_ID,
  buildBuyV2Ix,
  buildSellV2Ix,
  bondingCurvePda,
  creatorVaultPda,
  eventAuthorityPda,
  feeConfigPda,
  getAssociatedTokenAddressForProgram,
  globalPda,
  globalVolumeAccumulatorPda,
  sharingConfigPda,
  userVolumeAccumulatorPda,
} from "@mayhem/execution";

const baseMint = new PublicKey("So11111111111111111111111111111111111111112");
const quoteMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const feeRecipient = new PublicKey("11111111111111111111111111111111");
const buybackFeeRecipient = new PublicKey("SysvarRent111111111111111111111111111111111");
const user = new PublicKey("Vote111111111111111111111111111111111111111");
const creator = new PublicKey("Stake11111111111111111111111111111111111111");

const accounts = {
  baseMint,
  quoteMint,
  baseTokenProgram: TOKEN_PROGRAM_ID,
  quoteTokenProgram: TOKEN_PROGRAM_ID,
  feeRecipient,
  buybackFeeRecipient,
  user,
  creator,
};

const expectedBuyNames = [
  globalPda(),
  baseMint,
  quoteMint,
  TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  feeRecipient,
  getAssociatedTokenAddressForProgram(quoteMint, feeRecipient, TOKEN_PROGRAM_ID),
  buybackFeeRecipient,
  getAssociatedTokenAddressForProgram(quoteMint, buybackFeeRecipient, TOKEN_PROGRAM_ID),
  bondingCurvePda(baseMint),
  getAssociatedTokenAddressForProgram(
    baseMint,
    bondingCurvePda(baseMint),
    TOKEN_PROGRAM_ID,
  ),
  getAssociatedTokenAddressForProgram(
    quoteMint,
    bondingCurvePda(baseMint),
    TOKEN_PROGRAM_ID,
  ),
  user,
  getAssociatedTokenAddressForProgram(baseMint, user, TOKEN_PROGRAM_ID),
  getAssociatedTokenAddressForProgram(quoteMint, user, TOKEN_PROGRAM_ID),
  creatorVaultPda(creator),
  getAssociatedTokenAddressForProgram(
    quoteMint,
    creatorVaultPda(creator),
    TOKEN_PROGRAM_ID,
  ),
  sharingConfigPda(baseMint),
  globalVolumeAccumulatorPda(),
  userVolumeAccumulatorPda(user),
  getAssociatedTokenAddressForProgram(
    quoteMint,
    userVolumeAccumulatorPda(user),
    TOKEN_PROGRAM_ID,
  ),
  feeConfigPda(),
  FEE_PROGRAM,
  SystemProgram.programId,
  eventAuthorityPda(),
  PUMP_PROGRAM,
];

describe("pump.fun V2 IDL ABI", () => {
  it("encodes buy_v2 discriminator, u64 arguments, and all 27 IDL accounts in order", () => {
    const ix = buildBuyV2Ix(accounts, {
      amount: 123n,
      maxSolCost: 456n,
    });

    expect(ix.programId.equals(PUMP_PROGRAM)).toBe(true);
    expect(ix.keys.map((key) => key.pubkey.toBase58())).toEqual(
      expectedBuyNames.map((key) => key.toBase58()),
    );
    expect(ix.keys.map((key) => [key.isWritable, key.isSigner])).toEqual([
      [false, false], [false, false], [false, false], [false, false],
      [false, false], [false, false], [true, false], [true, false],
      [true, false], [true, false], [true, false], [true, false],
      [true, false], [true, true], [true, false], [true, false],
      [true, false], [true, false], [false, false], [false, false],
      [true, false], [true, false], [false, false], [false, false],
      [false, false], [false, false], [false, false],
    ]);
    expect(ix.data.subarray(0, 8)).toEqual(BUY_DISCRIMINATOR_V2);
    expect(ix.data.readBigUInt64LE(8)).toBe(123n);
    expect(ix.data.readBigUInt64LE(16)).toBe(456n);
    expect(ix.data.length).toBe(24);
  });

  it("encodes sell_v2 with the IDL's 26-account order and exact u64 arguments", () => {
    const ix = buildSellV2Ix(accounts, {
      amount: 789n,
      minSolOutput: 321n,
    });

    expect(ix.programId.equals(PUMP_PROGRAM)).toBe(true);
    expect(ix.keys).toHaveLength(26);
    expect(ix.keys.some((key) => key.pubkey.equals(globalVolumeAccumulatorPda()))).toBe(false);
    expect(ix.keys.map((key) => key.pubkey.toBase58())).toEqual(
      expectedBuyNames
        .filter((_, index) => index !== 19)
        .map((key) => key.toBase58()),
    );
    expect(ix.data.subarray(0, 8)).toEqual(SELL_DISCRIMINATOR_V2);
    expect(ix.data.readBigUInt64LE(8)).toBe(789n);
    expect(ix.data.readBigUInt64LE(16)).toBe(321n);
    expect(ix.data.length).toBe(24);
  });
});
