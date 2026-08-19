
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { JitoClient, AmbiguousSendError } from "./jito";
import { FeeBudget } from "./fee-budget";
import {
  buildSnipeTx, estimateTokensOut, globalPda,
  parseGlobal, PUMP_FEE_BPS, readBondingCurve,
} from "./pumpfun";
import { CircuitBreaker, GateResult } from "@mayhem/risk-engine";
import type { LaunchSignal } from "@mayhem/token-monitor";

export interface EngineConfig {
  hotWallet: Keypair;
  positionSolLamports: bigint;
  maxSlippagePct: number;
  maxConcurrentPositions: number;
  maxTxAgeMs: number;      // skip launches older than this
  landingTimeoutMs: number; // timeout for waiting on bundle landing
  preflightSim: boolean;   // require simulator pass before send
}

export type SnipeResult =
  | { status: "landed"; bundleId: string; mint: PublicKey }
  | { status: "blocked" | "skipped" | "failed"; reason: string; mint: PublicKey };

type OrderOutcome = "in_flight" | "filled" | "unknown";

interface OrderRecord {
  placedAt: number;
  outcome: OrderOutcome;
}

export class SnipeEngine {
  /**
   * mint base58 -> order record. Serves two distinct purposes that were
   * previously conflated: idempotency (have we already acted on this mint?)
   * and concurrency accounting (how many slots are in use?).
   */
  private readonly orders = new Map<string, OrderRecord>();
  private feeRecipient: PublicKey | null = null;

  /**
   * Age out orders that have been `in_flight` far longer than a send should
   * ever take.
   *
   * Nothing is DELETED here. A record stuck `in_flight` past the TTL means
   * the process died between reserving the mint and resolving the bundle —
   * so whether that bundle landed is unknown, and forgetting it would let
   * the same mint be sniped again on top of a position that may already
   * exist. It is promoted to `unknown` instead, which keeps the duplicate
   * guard and the concurrency slot while flagging it for reconciliation via
   * `unresolvedOrders()`.
   *
   * Returns the mints that were promoted so the caller can alert.
   */
  private sweepStale(now = Date.now(), ttlMs = 600_000): string[] {
    const promoted: string[] = [];
    for (const [mint, record] of this.orders) {
      if (record.outcome === "in_flight" && now - record.placedAt > ttlMs) {
        this.orders.set(mint, { placedAt: record.placedAt, outcome: "unknown" });
        promoted.push(mint);
      }
    }
    return promoted;
  }

  /** Public sweep so an operator/health loop can observe and alert. */
  sweepStaleOrders(now = Date.now(), ttlMs = 600_000): string[] {
    return this.sweepStale(now, ttlMs);
  }

  /**
   * Slots consumed. Every retained record consumes one: `in_flight` is
   * obviously live, `filled` is a real open position, and `unknown` is a
   * bundle that may have landed. Only a proven failure removes a record.
   */
  private activeCount(): number {
    return this.orders.size;
  }

  /**
   * Release a mint after the position manager has closed it out, or after
   * an operator has reconciled an `unknown` order. This is the ONLY way a
   * filled/unknown slot is freed — deliberately manual, because automatic
   * release is what allowed duplicate entries.
   */
  releaseMint(mint: string): boolean {
    return this.orders.delete(mint);
  }

  /** Mints whose outcome could not be determined and need reconciliation. */
  unresolvedOrders(): string[] {
    return [...this.orders.entries()]
      .filter(([, r]) => r.outcome === "unknown")
      .map(([mint]) => mint);
  }

  constructor(
    private readonly conn: Connection,
    private readonly jito: JitoClient,
    private readonly fees: FeeBudget,
    private readonly breaker: CircuitBreaker,
    private readonly cfg: EngineConfig,
  ) {}

  async snipe(
    signal: LaunchSignal & { mint: PublicKey },
    simulate: (mint: PublicKey, sizeLamports: bigint) => Promise<{ ok: boolean; reason?: string }>,
  ): Promise<SnipeResult> {
    const { mint } = signal;
    const mintKey = mint.toBase58();
    this.sweepStale();

    // 1. Circuit breaker â€” HARD gate, checked before anything else
    const gate: GateResult = this.breaker.shouldBlock();
    if (gate.block) return { status: "blocked", reason: gate.reason ?? "breaker", mint };

    // 2. Idempotency + concurrency caps
    if (this.orders.has(mintKey)) return { status: "skipped", reason: "duplicate", mint };
    if (this.activeCount() >= this.cfg.maxConcurrentPositions) {
      return { status: "skipped", reason: "max_concurrent", mint };
    }

    // 3. Freshness â€” a 6-second-old launch is a bag, not an edge
    if (Date.now() - signal.detectedAt > this.cfg.maxTxAgeMs) return { status: "skipped", reason: "stale", mint };

    // 4. Preflight simulation â€” mandatory when enabled
    if (this.cfg.preflightSim) {
      const sim = await simulate(mint, this.cfg.positionSolLamports);
      if (!sim.ok) return { status: "skipped", reason: sim.reason ?? "sim_failed", mint };
    }

    // 5. Curve state.
    //
    // This previously fell back to the program's *global initial reserves*
    // when the live bonding-curve account could not be read. Those reserves
    // describe a curve at launch, so any curve that has already traded gets
    // priced at a stale, far-too-cheap level: `estimateTokensOut` then asks
    // for a token amount the curve cannot deliver, and the order fills at up
    // to the full slippage cap. Sizing off a price we could not read is
    // guessing with real money — fail closed instead.
    await this.loadGlobal(); // still needed to resolve the fee recipient
    const state = await readBondingCurve(this.conn, mint);
    if (!state) {
      return { status: "skipped", reason: "bonding_curve_unreadable", mint };
    }

    const feeRecipient = this.feeRecipient;
    if (!feeRecipient) throw new Error("pump.fun fee recipient not loaded");

    // 6. Slippage cap = position + pump fee (1%) + allowed slippage
    const feeBps = BigInt(PUMP_FEE_BPS);
    const slipBps = BigInt(Math.round(this.cfg.maxSlippagePct * 100)); // 30% â†’ 3000
    const maxSolCost =
      (this.cfg.positionSolLamports * (10_000n + feeBps + slipBps)) / 10_000n;
    const tokenAmount = estimateTokensOut(state, this.cfg.positionSolLamports);

    // 8. Build, sign, bundle, send
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const buyTx = await buildSnipeTx(this.conn, {
      mint,
      payer: this.cfg.hotWallet.publicKey,
      feeRecipient,
      tokenAmount,
      maxSolCostLamports: maxSolCost,
      blockhash,
    });
    buyTx.sign(this.cfg.hotWallet);

    const tip = await this.fees.tipLamports();
    const tipTx = await this.jito.buildTipTx(this.cfg.hotWallet, blockhash, tip);

    const gate2 = this.breaker.shouldBlock();
    if (gate2.block) return { status: "blocked", reason: gate2.reason ?? "breaker", mint };

    // Reserve the mint BEFORE the send so a concurrent signal for the same
    // mint cannot race past the duplicate check.
    this.orders.set(mintKey, { placedAt: Date.now(), outcome: "in_flight" });

    let bundleId: string;
    try {
      bundleId = await this.jito.sendBundle([tipTx, buyTx]);
    } catch (err) {
      if (err instanceof AmbiguousSendError) {
        // The bundle may be in flight. Keep the reservation so this mint is
        // never re-sniped, and flag it for reconciliation.
        this.orders.set(mintKey, { placedAt: Date.now(), outcome: "unknown" });
        return { status: "failed", reason: "send_ambiguous", mint };
      }
      // Proven not sent — free the slot.
      this.orders.delete(mintKey);
      return {
        status: "failed",
        reason: `send_rejected:${err instanceof Error ? err.message : String(err)}`,
        mint,
      };
    }

    const landed = await this.jito.waitForLanding(bundleId, this.cfg.landingTimeoutMs);

    if (landed.status === "Landed") {
      // Retain the reservation. The position manager owns the open position
      // from here and calls releaseMint() once it is closed. Deleting the
      // key on success (the previous behaviour) freed the concurrency slot
      // and the duplicate guard simultaneously, so the same mint could be
      // bought again and `maxConcurrentPositions` counted nothing.
      this.orders.set(mintKey, { placedAt: Date.now(), outcome: "filled" });
      return { status: "landed", bundleId, mint };
    }

    if (landed.status === "Invalid") {
      // Definitively rejected by the block engine — it cannot land.
      this.orders.delete(mintKey);
      return { status: "failed", reason: "bundle_Invalid", mint };
    }

    // Timeout: the bundle can still land after the deadline. Treating this
    // as "failed and free the slot" is what turns one intended buy into two.
    this.orders.set(mintKey, { placedAt: Date.now(), outcome: "unknown" });
    return { status: "failed", reason: "bundle_Timeout_unresolved", mint };
  }

  private async loadGlobal(): Promise<{ virtualTokenReserves: bigint; virtualSolReserves: bigint }> {
    const data = (await this.conn.getAccountInfo(globalPda()))?.data as Buffer | undefined;
    if (!data) throw new Error("pump.fun global account not found");
    const global = parseGlobal(data);
    this.feeRecipient ??= global.feeRecipient;
    return {
      virtualTokenReserves: global.virtualTokenReserves,
      virtualSolReserves: global.virtualSolReserves,
    };
  }
}