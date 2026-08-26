import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildBuyV2Ix,
  TOKEN_PROGRAM_ID,
} from "@mayhem/execution";

describe("pump.fun token-program safety policy", () => {
  it("accepts the classic SPL Token program", () => {
    expect(() =>
      buildBuyV2Ix(
        {
          baseMint: PublicKey.default,
          quoteMint: PublicKey.default,
          baseTokenProgram: TOKEN_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          feeRecipient: PublicKey.default,
          buybackFeeRecipient: PublicKey.default,
          user: PublicKey.default,
          creator: PublicKey.default,
        },
        { amount: 1n, maxSolCost: 1n },
      ),
    ).not.toThrow();
  });

  it("rejects Token-2022 instead of constructing an unsafe transaction", () => {
    const token2022 = new PublicKey(
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    );
    expect(() =>
      buildBuyV2Ix(
        {
          baseMint: PublicKey.default,
          quoteMint: PublicKey.default,
          baseTokenProgram: token2022,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          feeRecipient: PublicKey.default,
          buybackFeeRecipient: PublicKey.default,
          user: PublicKey.default,
          creator: PublicKey.default,
        },
        { amount: 1n, maxSolCost: 1n },
      ),
    ).toThrow("unsupported_token_program");
  });

  it("rejects any unknown token program", () => {
    expect(() =>
      buildBuyV2Ix(
        {
          baseMint: PublicKey.default,
          quoteMint: PublicKey.default,
          baseTokenProgram: Keypair.generate().publicKey,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          feeRecipient: PublicKey.default,
          buybackFeeRecipient: PublicKey.default,
          user: PublicKey.default,
          creator: PublicKey.default,
        },
        { amount: 1n, maxSolCost: 1n },
      ),
    ).toThrow("unsupported_token_program");
  });
});
