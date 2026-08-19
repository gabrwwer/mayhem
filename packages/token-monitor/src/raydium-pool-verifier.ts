import {
  CpmmPoolInfoLayout,
  liquidityStateV4Layout,
} from '@raydium-io/raydium-sdk-v2';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  RAYDIUM_AMM_V4,
  RAYDIUM_CPMM,
  SOL_MINT,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from '@mayhem/solana';

/*
 * Program ids come from @mayhem/solana, not from literals re-typed here.
 *
 * This file previously declared its own TOKEN_2022_PROGRAM_ID as
 * "TokenzQdBNbLqP5VEhdkDkHaZM2LRcH7LCa4Lb1o4pR", which is NOT the
 * Token-2022 program (the real id is ...AS6EPFLC1PHnBqCXEpPxuEb). The
 * consequence was specific and silent: `isSupportedTokenProgram` rejected
 * every Token-2022 vault, so any pool holding a Token-2022 mint failed
 * verification with "unsupported token program". pump.fun mints ARE
 * Token-2022, so every graduated pump token was unverifiable — which is a
 * large part of why the Raydium path behaved as observation-only.
 *
 * That is the third wrong program id found in this codebase. Hand-typed
 * base58 is the common factor; importing shared constants is the fix.
 */
const RAYDIUM_AMM_V4_PROGRAM_ID = RAYDIUM_AMM_V4.toBase58();
const RAYDIUM_CPMM_PROGRAM_ID = RAYDIUM_CPMM.toBase58();
const WSOL_MINT = SOL_MINT;
const SPL_TOKEN_PROGRAM_ID = TOKEN_PROGRAM.toBase58();
const TOKEN_2022_PROGRAM_ID = TOKEN_2022_PROGRAM.toBase58();

export type RaydiumPoolType = 'amm-v4' | 'cpmm';

export type VerifiedRaydiumPool = {
  verified: true;
  poolType: RaydiumPoolType;
  programId: string;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  lpMint: string;
  quoteReserveSol: number;
  poolVerifiedAtMs: number;
};

export type RejectedRaydiumPool = {
  verified: false;
  reason: string;
};

export type RaydiumPoolVerification =
  | VerifiedRaydiumPool
  | RejectedRaydiumPool;

type VaultInfo = {
  address: string;
  mint: string;
  amountRaw: string;
  tokenProgram: string;
};

export class RaydiumPoolVerifier {
  private readonly connection: Connection;

  constructor(rpcUrl: string) {
    if (!rpcUrl?.trim()) {
      throw new Error('RaydiumPoolVerifier requires a Solana RPC URL');
    }

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    });
  }

  async verifyPool(input: {
    poolAddress: string;
    programId: string;
    expectedTokenMint?: string;
  }): Promise<RaydiumPoolVerification> {
    if (!input.expectedTokenMint?.trim()) {
      return {
        verified: false,
        reason: 'Expected token mint is required for pool verification',
      };
    }

    const poolType = this.poolTypeFor(input.programId);

    if (!poolType) {
      return {
        verified: false,
        reason: `Unsupported Raydium program: ${input.programId}`,
      };
    }

    try {
      const poolAddress = new PublicKey(input.poolAddress);
      const accountInfo = await this.connection.getAccountInfo(
        poolAddress,
        'confirmed',
      );

      if (!accountInfo) {
        return {
          verified: false,
          reason: 'Pool account was not found',
        };
      }

      if (accountInfo.executable) {
        return {
          verified: false,
          reason: 'Pool candidate is an executable program account',
        };
      }

      if (accountInfo.owner.toBase58() !== input.programId) {
        return {
          verified: false,
          reason:
            'Pool account owner does not match the expected Raydium program',
        };
      }

      const decoded = poolType === 'amm-v4'
        ? this.decodeAmmV4(accountInfo.data)
        : this.decodeCpmm(accountInfo.data);

      if (!decoded) {
        return {
          verified: false,
          reason: `Account data does not match the ${poolType} pool-state layout`,
        };
      }

      const pair = this.resolveWsolPair(
        decoded.mintA,
        decoded.mintB,
        decoded.vaultA,
        decoded.vaultB,
        input.expectedTokenMint,
      );

      if (!pair) {
        return {
          verified: false,
          reason:
            'Pool is not an expected-token/WSOL pair, or its mint pair is invalid',
        };
      }

      const [tokenVault, wsolVault] = await Promise.all([
        this.readVault(pair.tokenVault),
        this.readVault(pair.wsolVault),
      ]);

      if (!tokenVault || !wsolVault) {
        return {
          verified: false,
          reason: 'One or more pool vaults are not valid parsed token accounts',
        };
      }

      if (tokenVault.mint !== input.expectedTokenMint) {
        return {
          verified: false,
          reason: 'Token vault mint does not match the expected token mint',
        };
      }

      if (wsolVault.mint !== WSOL_MINT) {
        return {
          verified: false,
          reason: 'Quote vault mint is not wrapped SOL',
        };
      }

      if (
        !this.isSupportedTokenProgram(tokenVault.tokenProgram) ||
        !this.isSupportedTokenProgram(wsolVault.tokenProgram)
      ) {
        return {
          verified: false,
          reason: 'Pool vault uses an unsupported token program',
        };
      }

      const quoteReserveSol = this.lamportsToSol(wsolVault.amountRaw);

      if (!Number.isFinite(quoteReserveSol) || quoteReserveSol <= 0) {
        return {
          verified: false,
          reason: 'Wrapped-SOL vault has no positive reserve',
        };
      }

      return {
        verified: true,
        poolType,
        programId: input.programId,
        poolAddress: input.poolAddress,
        baseMint: pair.tokenMint,
        quoteMint: WSOL_MINT,
        baseVault: pair.tokenVault,
        quoteVault: pair.wsolVault,
        lpMint: decoded.lpMint,
        quoteReserveSol,
        poolVerifiedAtMs: Date.now(),
      };
    } catch (error) {
      return {
        verified: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private decodeAmmV4(data: Buffer): {
    mintA: string;
    mintB: string;
    vaultA: string;
    vaultB: string;
    lpMint: string;
  } | null {
    try {
      if (data.length !== liquidityStateV4Layout.span) {
        return null;
      }

      const state = liquidityStateV4Layout.decode(data);

      return {
        mintA: state.baseMint.toBase58(),
        mintB: state.quoteMint.toBase58(),
        vaultA: state.baseVault.toBase58(),
        vaultB: state.quoteVault.toBase58(),
        lpMint: state.lpMint.toBase58(),
      };
    } catch {
      return null;
    }
  }

  private decodeCpmm(data: Buffer): {
    mintA: string;
    mintB: string;
    vaultA: string;
    vaultB: string;
    lpMint: string;
  } | null {
    try {
      if (data.length !== CpmmPoolInfoLayout.span) {
        return null;
      }

      const state = CpmmPoolInfoLayout.decode(data);

      return {
        mintA: state.mintA.toBase58(),
        mintB: state.mintB.toBase58(),
        vaultA: state.vaultA.toBase58(),
        vaultB: state.vaultB.toBase58(),
        lpMint: state.mintLp.toBase58(),
      };
    } catch {
      return null;
    }
  }

  private resolveWsolPair(
    mintA: string,
    mintB: string,
    vaultA: string,
    vaultB: string,
    expectedTokenMint: string,
  ): {
    tokenMint: string;
    tokenVault: string;
    wsolVault: string;
  } | null {
    if (mintA === expectedTokenMint && mintB === WSOL_MINT) {
      return {
        tokenMint: mintA,
        tokenVault: vaultA,
        wsolVault: vaultB,
      };
    }

    if (mintB === expectedTokenMint && mintA === WSOL_MINT) {
      return {
        tokenMint: mintB,
        tokenVault: vaultB,
        wsolVault: vaultA,
      };
    }

    return null;
  }

  private async readVault(address: string): Promise<VaultInfo | null> {
    try {
      const response = await this.connection.getParsedAccountInfo(
        new PublicKey(address),
        'confirmed',
      );

      const value = response.value;

      if (!value) {
        return null;
      }

      const data = value.data as {
        parsed?: {
          type?: string;
          info?: {
            mint?: string;
            tokenAmount?: {
              amount?: string;
            };
          };
        };
      };

      if (
        data.parsed?.type !== 'account' ||
        !data.parsed.info?.mint ||
        !data.parsed.info.tokenAmount?.amount
      ) {
        return null;
      }

      return {
        address,
        mint: data.parsed.info.mint,
        amountRaw: data.parsed.info.tokenAmount.amount,
        tokenProgram: value.owner.toBase58(),
      };
    } catch {
      return null;
    }
  }

  private lamportsToSol(amountRaw: string): number {
    const amount = Number(amountRaw);

    if (!Number.isSafeInteger(amount)) {
      return Number.NaN;
    }

    return amount / 1e9;
  }

  private isSupportedTokenProgram(programId: string): boolean {
    return (
      programId === SPL_TOKEN_PROGRAM_ID ||
      programId === TOKEN_2022_PROGRAM_ID
    );
  }

  private poolTypeFor(programId: string): RaydiumPoolType | null {
    if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
      return 'amm-v4';
    }

    if (programId === RAYDIUM_CPMM_PROGRAM_ID) {
      return 'cpmm';
    }

    return null;
  }
}