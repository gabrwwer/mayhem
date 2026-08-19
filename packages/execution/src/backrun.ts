
import { Connection, Logs, PublicKey } from "@solana/web3.js";
import { EventEmitter } from "node:events";
import { PUMP_PROGRAM } from "./pumpfun";

export interface WhaleBuy {
  signature: string;
  mint: PublicKey;
  solSpentLamports: bigint;
  detectedAt: number;
}

/**
 * Whale-buy backrunner.
 * Detects large confirmed pump.fun buys and emits them ~1-2 slots after the whale.
 * SnipeEngine then buys in the same block window â€” you ride the momentum a whale
 * just created. This is backrunning (legit MEV, Jito-allowed): we never modify,
 * front-run, or sandwich the whale's tx. Unlike launch sniping, this is not a
 * lottery â€” it's follow-through on confirmed capital, and it scales.
 */
export class WhaleBackrun extends EventEmitter {
  private readonly seen = new Set<string>();

  constructor(
    private readonly conn: Connection,
    private readonly minSolLamports: bigint,
  ) {
    super();
  }

  start(): void {
    this.conn.onLogs(PUMP_PROGRAM, (logs: Logs) => void this.onLogs(logs), "confirmed");
  }

  private async onLogs(logs: Logs): Promise<void> {
    if (logs.err || !logs.logs.some((l) => l.includes("Instruction: Buy"))) return;
    if (this.seen.has(logs.signature)) return;
    this.seen.add(logs.signature);

    try {
      const parsed = await this.conn.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!parsed || parsed.meta?.err) return;
      const buy = parseBuy(parsed);
      if (!buy || buy.solSpentLamports < this.minSolLamports) return;
      this.emit("whale-buy", {
        signature: logs.signature,
        mint: buy.mint,
        solSpentLamports: buy.solSpentLamports,
        detectedAt: Date.now(),
      } satisfies WhaleBuy);
    } catch {
      /* best-effort */
    }
  }
}

// buy ix data: discriminator(8) | tokenAmount u64 | maxSolCost u64
// getParsedTransaction returns a mix: pump.fun has no built-in parser, so its
// instructions arrive as PartiallyDecodedInstruction (accounts: string[], data:
// base64). ParsedInstruction (parsed programs) carries no `data` â€” skip those.
type AnyBuyInstruction = {
  programId: PublicKey;
  accounts?: unknown[];
  data?: string;
};

function parseBuy(parsed: {
  transaction: { message: { instructions: AnyBuyInstruction[] } };
}): { mint: PublicKey; solSpentLamports: bigint } | null {
  const ix = parsed.transaction.message.instructions.find(
    (i) => i.programId.equals(PUMP_PROGRAM) && typeof i.data === "string",
  );
  if (!ix || typeof ix.data !== "string") return null;
  const mint = ix.accounts?.[2]; // buy layout: [global, fee_recipient, mint, ...]
  if (typeof mint !== "string") return null;
  const data = Buffer.from(ix.data, "base64");
  if (data.length < 24) return null;
  const maxSolCost = data.readBigUInt64LE(16); // SOL cap the whale was willing to spend
  return { mint: new PublicKey(mint), solSpentLamports: maxSolCost };
}