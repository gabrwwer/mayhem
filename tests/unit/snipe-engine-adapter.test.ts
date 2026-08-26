import { SnipeEngineAdapter } from "@mayhem/execution";

describe("SnipeEngineAdapter", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };

  it("translates only a confirmed result", async () => {
    const engine = {
      executePumpFunBuy: vi.fn().mockResolvedValue({
        status: "confirmed",
        bundleId: "bundle",
        txSig: "real-signature",
        mint: { toBase58: () => "mint" },
        filledAmount: 123_000_000n,
        filledPrice: 456 / 123,
        solSpent: 456_000_000n,
        fees: 7_000n,
      }),
    };
    const adapter = new SnipeEngineAdapter(engine as never, logger);

    await expect(adapter.executePumpFunBuy("mint", '0.001')).resolves.toMatchObject({
      signature: "real-signature",
      status: "confirmed",
      filledOutputAmount: '123',
      filledInputAmount: '0.456',
      fees: '0.000007',
    });
  });

  it("does not fabricate a result for ambiguous execution", async () => {
    const engine = {
      executePumpFunBuy: vi.fn().mockResolvedValue({
        status: "ambiguous",
        reason: "timeout",
        mint: { toBase58: () => "mint" },
      }),
    };
    const adapter = new SnipeEngineAdapter(engine as never, logger);

    await expect(adapter.executePumpFunBuy("mint", '0.001')).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
});
