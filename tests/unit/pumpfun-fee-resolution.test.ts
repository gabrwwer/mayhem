import { Keypair } from "@solana/web3.js";
import {
  GLOBAL_DISCRIMINATOR,
  parseGlobal,
  resolveFeeRecipients,
} from "@mayhem/execution";

function writePubkey(data: Buffer, offset: number, value = Keypair.generate().publicKey): string {
  value.toBuffer().copy(data, offset);
  return value.toBase58();
}

function globalFixture() {
  const data = Buffer.alloc(1045);
  GLOBAL_DISCRIMINATOR.copy(data, 0);
  data[8] = 1;
  const normal = writePubkey(data, 41);
  const reserved = writePubkey(data, 483);
  const buyback = writePubkey(data, 741);
  data.writeBigUInt64LE(100n, 105);
  return { data, normal, reserved, buyback };
}

describe("pump.fun fee recipient resolution", () => {
  it("decodes and selects recipients from the authoritative Global account", () => {
    const fixture = globalFixture();
    const global = parseGlobal(fixture.data);
    const resolved = resolveFeeRecipients(global, false);

    expect(resolved.feeRecipient.toBase58()).toBe(fixture.normal);
    expect(resolved.buybackFeeRecipient.toBase58()).toBe(fixture.buyback);
  });

  it("selects the reserved fee recipient for mayhem-mode execution", () => {
    const fixture = globalFixture();
    const resolved = resolveFeeRecipients(parseGlobal(fixture.data), true);

    expect(resolved.feeRecipient.toBase58()).toBe(fixture.reserved);
  });

  it("fails closed when the Global account has no authorized recipients", () => {
    const fixture = globalFixture();
    fixture.data.fill(0, 41, 73);
    fixture.data.fill(0, 162, 386);
    fixture.data.fill(0, 483, 515);
    fixture.data.fill(0, 516, 740);
    fixture.data.fill(0, 741, 997);

    expect(() => resolveFeeRecipients(parseGlobal(fixture.data), false)).toThrow(
      "fee recipient set is empty",
    );
  });
});
