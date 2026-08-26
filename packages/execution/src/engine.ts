import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
declare const require: (moduleName: string) => any;
const { mkdir, readFile, rename, writeFile } = require("fs/promises") as {
  mkdir: (path: string, options: { recursive: boolean }) => Promise<void>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  writeFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
};
const { dirname } = require("path") as { dirname: (path: string) => string };
const { randomUUID } = require("crypto") as { randomUUID: () => string };
import { JitoClient, AmbiguousSendError } from "./jito";
import { FeeBudget } from "./fee-budget";
import {
  buildSnipeTx, estimateTokensOut, globalPda,
  parseGlobal, readBondingCurve,
  buildSellTx,
  isPumpFunToken,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  resolveFeeRecipients,
  GlobalState,
  BondingCurveState,
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
  orderStore?: DurableOrderStore;
  orderStorePath?: string;
}

export type SnipeResult =
  | {
      status: "confirmed";
      bundleId: string;
      txSig: string;
      mint: PublicKey;
      filledAmount: bigint;
      filledPrice: string;
      solSpent: bigint;
      fees: bigint;
    }
  | {
      status: "blocked" | "skipped" | "failed" | "ambiguous";
      reason: string;
      mint: PublicKey;
    };

export type OrderState =
  | "prepared"
  | "submitted"
  | "landed"
  | "confirmed"
  | "partially_filled"
  | "failed"
  | "ambiguous"
  | "reconciled";

export interface DurableOrderRecord {
  orderId: string;
  mint: string;
  side: "buy" | "sell";
  state: OrderState;
  placedAt: number;
  bundleId?: string;
  transactionSignature?: string;
  requestedQuantity: string;
  filledQuantity?: string;
  requestedPositionSol?: string;
  actualSolSpent?: string;
  actualSolReceived?: string;
  feesLamports?: string;
  feesSol?: string;
  submittedAt?: number;
  landedAt?: number;
  confirmedAt?: number;
  lastReconciledAt?: number;
  retryCount: number;
  reconciliationState: "unreconciled" | "reconciling" | "reconciled" | "failed";
  errorCode?: string;
}

interface OrderRecord extends DurableOrderRecord {
  outcome: "in_flight" | "filled" | "unknown";
}

type PersistedOrders = Record<string, DurableOrderRecord>;

function createOrderRecord(
  mint: string,
  side: "buy" | "sell",
  requestedQuantity: bigint,
  requestedPositionSol?: bigint,
): OrderRecord {
  return {
    orderId: randomUUID(),
    mint,
    side,
    state: "prepared",
    placedAt: Date.now(),
    outcome: "in_flight",
    requestedQuantity: requestedQuantity.toString(),
    ...(requestedPositionSol === undefined
      ? {}
      : { requestedPositionSol: requestedPositionSol.toString() }),
    retryCount: 0,
    reconciliationState: "unreconciled",
  };
}

export interface DurableOrderStore {
  load(): Promise<Record<string, DurableOrderRecord>>;
  save(orders: Record<string, DurableOrderRecord>): Promise<void>;
}

class JsonOrderStore implements DurableOrderStore {
  constructor(private readonly filePath: string) 
  {}

  async load(): Promise<PersistedOrders> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, DurableOrderRecord>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("order store must contain an object");
      }
      return parsed;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) return {};
      throw new Error(
        `cannot load unresolved order store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async save(orders: Record<string, DurableOrderRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(orders), "utf8");
    await rename(temporary, this.filePath);
  }
}

export class SnipeEngine {
  /**
   * mint base58 -> order record. Serves two distinct purposes that were
   * previously conflated: idempotency (have we already acted on this mint?)
   * and concurrency accounting (how many slots are in use?).
   */
  private readonly orders = new Map<string, OrderRecord>();
  private feeRecipient: PublicKey | null = null;
  private buybackFeeRecipient: PublicKey | null = null;
  private readonly orderStore: DurableOrderStore | null;
  private readonly persistenceReady: Promise<void>;

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
        this.orders.set(mint, { ...record, outcome: "unknown" });
        promoted.push(mint);
      }
    }
    return promoted;
  }

  /** Public sweep so an operator/health loop can observe and alert. */
  sweepStaleOrders(now = Date.now(), ttlMs = 600_000): string[] {
    const promoted = this.sweepStale(now, ttlMs);
    if (promoted.length > 0) void this.persistOrders();
    return promoted;
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
    const released = this.orders.delete(mint);
    if (released) void this.persistOrders();
    return released;
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
  ) {
    this.orderStore =
      cfg.orderStore ??
      (cfg.orderStorePath ? new JsonOrderStore(cfg.orderStorePath) : null);
    this.persistenceReady = this.restoreOrders();
  }

  get jitoClient(): JitoClient {
    return this.jito;
  }

  private async restoreOrders(): Promise<void> {
    if (!this.orderStore) return;
    const persisted = await this.orderStore.load();
    for (const [mint, record] of Object.entries(persisted)) {
      if (typeof record.placedAt !== "number" || !Number.isFinite(record.placedAt)) continue;
      if (!record.orderId || !record.mint || !record.side || !record.state) continue;
      this.orders.set(mint, {
        ...record,
        outcome:
          record.state === "confirmed" || record.state === "reconciled"
            ? "filled"
            : record.state === "failed"
              ? "unknown"
              : "in_flight",
      });
    }
  }

  private async persistOrders(): Promise<void> {
    if (!this.orderStore) return;
    await this.orderStore.save(Object.fromEntries(this.orders));
  }

  async reconcileOrders(): Promise<string[]> {
    await this.persistenceReady;
    const released: string[] = [];
    for (const [mint, record] of this.orders) {
      if (!record.bundleId || record.outcome === "filled") continue;
      const status = await this.jito.bundleStatus(record.bundleId);
      if (status === "Landed") {
        // Landing proves only that the bundle reached the block engine. A
        // restart may not have the pre-trade balances needed to prove a fill,
        // so never promote a landed order directly to filled.
        this.orders.set(mint, {
          ...record,
          state: record.transactionSignature ? "landed" : "ambiguous",
          outcome: "unknown",
          reconciliationState: "unreconciled",
          errorCode: record.transactionSignature
            ? "restart_reconciliation_required"
            : "landed_bundle_requires_transaction_reconciliation",
        });
      } else if (status === "Invalid") {
        this.orders.delete(mint);
        released.push(mint);
      } else {
        this.orders.set(mint, { ...record, outcome: "unknown" });
      }
    }
    await this.persistOrders();
    return released;
  }

  private async reconcileBuyOnChain(params: {
    txSig: string;
    mint: PublicKey;
    tokenBalanceBefore: bigint;
    expectedSolSpent: bigint;
  }): Promise<{
    success: boolean;
    error?: string;
    actualTokenReceived?: bigint;
    actualPrice?: string;
    actualSolSpent?: bigint;
    fees?: bigint;
  }> {
    const status = await this.conn.getSignatureStatus(params.txSig, {
      searchTransactionHistory: true,
    });
    if (status.value?.err || status.value?.confirmationStatus !== "confirmed") {
      return { success: false, error: "transaction_not_confirmed" };
    }

    const ata = getAssociatedTokenAddressSync(params.mint, this.cfg.hotWallet.publicKey, true);
    const balance = await this.conn.getTokenAccountBalance(ata, "confirmed");
    const after = BigInt(balance.value.amount);
    if (after <= params.tokenBalanceBefore) {
      return { success: false, error: "no_token_received" };
    }
    const actualTokenReceived = after - params.tokenBalanceBefore;

    const tx = await this.conn.getTransaction(params.txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return { success: false, error: "transaction_not_found" };
    const accountKeys = tx.transaction.message.getAccountKeys();
    const walletIndex = Array.from({ length: accountKeys.length }, (_, index) => index)
      .find((index) => accountKeys.get(index)?.equals(this.cfg.hotWallet.publicKey)) ?? -1;
    if (walletIndex < 0) return { success: false, error: "wallet_not_in_transaction" };

    const pre = BigInt(tx.meta.preBalances[walletIndex] ?? 0);
    const post = BigInt(tx.meta.postBalances[walletIndex] ?? 0);
    const actualSolSpent = pre > post ? pre - post : 0n;
    const fees = BigInt(tx.meta.fee);
    if (actualSolSpent <= 0n || actualSolSpent > params.expectedSolSpent) {
      return { success: false, error: "sol_spend_outside_expected_bound" };
    }

    return {
      success: true,
      actualTokenReceived,
      actualPrice: decimalDiv(actualSolSpent, actualTokenReceived),
      actualSolSpent,
      fees,
    };
  }

  private async reconcileSellOnChain(params: {
    txSig: string;
    mint: PublicKey;
    tokenBalanceBefore: bigint;
    expectedSolReceived: bigint;
  }): Promise<{
    success: boolean;
    error?: string;
    actualTokenSpent?: bigint;
    actualPrice?: string;
    actualSolReceived?: bigint;
    fees?: bigint;
  }> {
    const status = await this.conn.getSignatureStatus(params.txSig, {
      searchTransactionHistory: true,
    });
    if (status.value?.err || status.value?.confirmationStatus !== "confirmed") {
      return { success: false, error: "transaction_not_confirmed" };
    }

    const tx = await this.conn.getTransaction(params.txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return { success: false, error: "transaction_not_found" };
    const accountKeys = tx.transaction.message.getAccountKeys();
    const walletIndex = Array.from({ length: accountKeys.length }, (_, index) => index)
      .find((index) => accountKeys.get(index)?.equals(this.cfg.hotWallet.publicKey)) ?? -1;
    if (walletIndex < 0) return { success: false, error: "wallet_not_in_transaction" };

    const ata = getAssociatedTokenAddressSync(params.mint, this.cfg.hotWallet.publicKey, true);
    let after = 0n;
    try {
      after = BigInt((await this.conn.getTokenAccountBalance(ata, "confirmed")).value.amount);
    } catch {
      return { success: false, error: "token_account_not_found" };
    }
    if (after >= params.tokenBalanceBefore) {
      return { success: false, error: "no_token_decrease" };
    }

    const pre = BigInt(tx.meta.preBalances[walletIndex] ?? 0);
    const post = BigInt(tx.meta.postBalances[walletIndex] ?? 0);
    const actualSolReceived = post > pre ? post - pre : 0n;
    if (actualSolReceived <= 0n) {
      return { success: false, error: "no_sol_received" };
    }

    return {
      success: true,
      actualTokenSpent: params.tokenBalanceBefore - after,
      actualPrice: decimalDiv(actualSolReceived, params.tokenBalanceBefore - after),
      actualSolReceived,
      fees: BigInt(tx.meta.fee),
    };
  }

  async executePumpFunBuy(
    mint: string,
    amountSol: string,
  ): Promise<SnipeResult> {
    if (!isPositiveDecimal(amountSol)) {
      return {
        status: "failed",
        reason: "invalid_buy_amount",
        mint: new PublicKey(mint),
      };
    }
    return this.snipe(
      { mint: new PublicKey(mint), detectedAt: Date.now() },
      undefined,
      decimalToBaseUnits(amountSol.toString(), 9),
    );
  }

  async snipe(
    signal: LaunchSignal & { mint: PublicKey },
    simulate?: (mint: PublicKey, sizeLamports: bigint) => Promise<{ ok: boolean; reason?: string }>,
    sizeLamports = this.cfg.positionSolLamports,
  ): Promise<SnipeResult> {
    const { mint } = signal;
    const mintKey = mint.toBase58();
    await this.persistenceReady;
    await this.reconcileOrders();
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

    const buyAta = getAssociatedTokenAddressSync(mint, this.cfg.hotWallet.publicKey, true);
    let tokenBalanceBefore = 0n;
    try {
      const account = await this.conn.getAccountInfo(buyAta, "confirmed");
      if (account) {
        if (!account.owner.equals(TOKEN_PROGRAM_ID) || account.data.length < 165) {
          return { status: "skipped", reason: "ata_invalid", mint };
        }
        tokenBalanceBefore = BigInt(account.data.readBigUInt64LE(64).toString());
      }
    } catch {
      return { status: "skipped", reason: "ata_read_failed", mint };
    }

    // 4. Preflight simulation â€” mandatory when enabled
    if (this.cfg.preflightSim && simulate) {
      const sim = await simulate(mint, sizeLamports);
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
    try {
      await this.loadGlobal(); // still needed to resolve the fee recipient
    } catch {
      return { status: "skipped", reason: "global_account_unreadable", mint };
    }
    let state: BondingCurveState | null;
    try {
      state = await readBondingCurve(this.conn, mint);
    } catch {
      return { status: "skipped", reason: "bonding_curve_unreadable", mint };
    }
    if (!state) {
      return { status: "skipped", reason: "bonding_curve_unreadable", mint };
    }

    const global = await this.loadGlobal();
    const recipients = resolveFeeRecipients(global, state.isMayhemMode);
    this.feeRecipient = recipients.feeRecipient;
    this.buybackFeeRecipient = recipients.buybackFeeRecipient;
    const feeRecipient = this.feeRecipient;

    // 6. Slippage cap = position + pump fee (1%) + allowed slippage
    const feeBps = global.feeBasisPoints + global.creatorFeeBasisPoints;
    const slipBps = BigInt(
      new Decimal(this.cfg.maxSlippagePct)
        .times(100)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
        .toFixed(0),
    ); // 30% -> 3000
    const maxSolCost =
      (sizeLamports * (10_000n + feeBps + slipBps)) / 10_000n;
    const tokenAmount = estimateTokensOut(state, sizeLamports);

    // 8. Build, sign, bundle, send
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    let buyTx;
    try {
      buyTx = await buildSnipeTx(this.conn, {
        mint,
        payer: this.cfg.hotWallet.publicKey,
        feeRecipient,
        buybackFeeRecipient: this.buybackFeeRecipient!,
        tokenAmount,
        maxSolCostLamports: maxSolCost,
        blockhash,
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `live_buy_unsupported:${error instanceof Error ? error.message : String(error)}`,
        mint,
      };
    }
    buyTx.sign(this.cfg.hotWallet);

    if (this.cfg.preflightSim) {
      const simulation = await this.conn.simulateTransaction(buyTx, [], false);
      if (simulation.value.err) {
        return {
          status: "failed",
          reason: `buy_preflight_failed:${JSON.stringify(simulation.value.err)}`,
          mint,
        };
      }
    }

    const tip = await this.fees.tipLamports();
    const tipTx = await this.jito.buildTipTx(this.cfg.hotWallet, blockhash, tip);

    const gate2 = this.breaker.shouldBlock();
    if (gate2.block) return { status: "blocked", reason: gate2.reason ?? "breaker", mint };

    // Reserve the mint BEFORE the send so a concurrent signal for the same
    // mint cannot race past the duplicate check.
    this.orders.set(
      mintKey,
      createOrderRecord(mintKey, "buy", sizeLamports, sizeLamports),
    );
    await this.persistOrders();

    let bundleId: string;
    try {
      bundleId = await this.jito.sendBundle([tipTx, buyTx]);
      this.orders.set(mintKey, {
        ...this.orders.get(mintKey)!,
        state: "submitted",
        submittedAt: Date.now(),
        placedAt: Date.now(),
        outcome: "in_flight",
        bundleId,
      });
      await this.persistOrders();
    } catch (err) {
      if (err instanceof AmbiguousSendError) {
        // The bundle may be in flight. Keep the reservation so this mint is
        // never re-sniped, and flag it for reconciliation.
        this.orders.set(mintKey, {
          ...this.orders.get(mintKey)!,
          state: "ambiguous",
          reconciliationState: "unreconciled",
          outcome: "unknown",
          errorCode: "send_ambiguous",
        });
        await this.persistOrders();
        return { status: "failed", reason: "send_ambiguous", mint };
      }
      // Proven not sent — free the slot.
      this.orders.delete(mintKey);
      await this.persistOrders();
      return {
        status: "failed",
        reason: `send_rejected:${err instanceof Error ? err.message : String(err)}`,
        mint,
      };
    }

    const landed = await this.jito.waitForLanding(bundleId, this.cfg.landingTimeoutMs);

    if (landed.status === "Landed") {
      const txSig = landed.transactions?.[1];
      if (!txSig) {
        this.orders.set(mintKey, {
          ...this.orders.get(mintKey)!,
          state: "ambiguous",
          outcome: "unknown",
          bundleId,
          errorCode: "landed_bundle_missing_transaction_signature",
        });
        await this.persistOrders();
        return { status: "ambiguous", reason: "landed_bundle_missing_transaction_signature", mint };
      }
      const verification = await this.reconcileBuyOnChain({
        txSig,
        mint,
        tokenBalanceBefore,
        expectedSolSpent: maxSolCost,
      });
      if (!verification.success) {
        this.orders.set(mintKey, {
          ...this.orders.get(mintKey)!,
          state: "ambiguous",
          outcome: "unknown",
          bundleId,
          errorCode: `chain_reconciliation_failed:${verification.error ?? "unknown"}`,
        });
        await this.persistOrders();
        return {
          status: "ambiguous",
          reason: `chain_reconciliation_failed:${verification.error ?? "unknown"}`,
          mint,
        };
      }
      this.orders.set(mintKey, {
        ...this.orders.get(mintKey)!,
        state: "confirmed",
        outcome: "filled",
        transactionSignature: txSig,
        filledQuantity: verification.actualTokenReceived!.toString(),
        actualSolSpent: verification.actualSolSpent!.toString(),
        feesLamports: verification.fees!.toString(),
        feesSol: baseUnitsToDecimalString(verification.fees!, 9),
        confirmedAt: Date.now(),
        lastReconciledAt: Date.now(),
        reconciliationState: "reconciled",
      });
      await this.persistOrders();
      return {
        status: "confirmed",
        bundleId,
        txSig,
        mint,
        filledAmount: verification.actualTokenReceived!,
        filledPrice: verification.actualPrice!,
        solSpent: verification.actualSolSpent!,
        fees: verification.fees!,
      };
    }

    if (landed.status === "Invalid") {
      // Definitively rejected by the block engine — it cannot land.
      this.orders.delete(mintKey);
      await this.persistOrders();
      return { status: "failed", reason: "bundle_Invalid", mint };
    }

    // Timeout: the bundle can still land after the deadline. Treating this
    // as "failed and free the slot" is what turns one intended buy into two.
    this.orders.set(mintKey, {
      ...this.orders.get(mintKey)!,
      state: "ambiguous",
      outcome: "unknown",
      bundleId,
      errorCode: "bundle_landing_timeout",
    });
    await this.persistOrders();
    return { status: "ambiguous", reason: "bundle_Timeout_unresolved", mint };
  }

  /**
   * Calculate expected SOL output when selling tokens on pump.fun V2 bonding curve.
   * Uses the official pump.fun bonding-curve formula (hyperbolic AMM).
   *
   * Source: https://github.com/pump-fun/pump-public-docs/blob/main/docs/bonding-curve-math.md
   */
  private estimateSellQuote(
    bondingCurve: BondingCurveState,
    tokenAmount: bigint,
    config: {
      feeBps: bigint; // pump.fun fee in basis points
      slippagePct: Decimal; // max slippage percentage
    }
  ): {
    solOutput: bigint;
    fee: bigint;
    minSolAfterSlippage: bigint;
  } {
    if (tokenAmount <= 0n) {
      throw new Error("Token amount must be positive");
    }

    // Get current reserves from bonding curve
    const vTok = bondingCurve.virtualTokenReserves;
    const vSol = bondingCurve.virtualSolReserves;
    const rTok = bondingCurve.realTokenReserves;
    const rSol = bondingCurve.realSolReserves;

    if (vTok <= 0n || vSol <= 0n) {
      throw new Error("Invalid bonding curve reserves");
    }

    // Hyperbolic AMM formula: k = vTok * vSol (constant product)
    // When selling tokens: vTok_new = vTok + tokenAmount
    // Output: vSol_out = vSol - (k / vTok_new)
    const k = vTok * vSol;
    const vTokAfter = vTok + tokenAmount;
    const vSolAfter = k / vTokAfter;
    let solOutput = vSol - vSolAfter;

    // Apply pump.fun fee
    const feeAmount = (solOutput * config.feeBps) / 10000n;
    const solAfterFee = solOutput - feeAmount;

    // Apply slippage
    const slippageBps = BigInt(
      config.slippagePct
        .times(100)
        .toDecimalPlaces(0, Decimal.ROUND_DOWN)
        .toFixed(0),
    );
    const slippageAmount = (solAfterFee * slippageBps) / 10000n;
    const minSolOutput = solAfterFee - slippageAmount;

    return {
      solOutput,
      fee: feeAmount,
      minSolAfterSlippage: minSolOutput,
    };
  }

  /**
   * Execute a pump.fun sell transaction using the same safety model as BUY.
   *
   * @param mint The token mint to sell
   * @param tokenAmount The amount of tokens to sell (in base units, i.e., tokenAmount * 10^decimals)
   * @param simulate A simulation function that validates the trade off-chain (e.g., checks slippage, fee, etc.)
   * @returns A promise that resolves to the result of the sell execution
   */
  async executePumpFunSell(
    mint: PublicKey,
    tokenAmount: bigint,
    simulate?: (mint: PublicKey, sizeLamports: bigint) => Promise<{ ok: boolean; reason?: string }>,
  ): Promise<SnipeResult> {
    const mintKey = mint.toBase58();
    await this.persistenceReady;
    await this.reconcileOrders();
    this.sweepStale();

    // Exits, including emergency liquidation, must remain available when the
    // breaker is open. The breaker gates new entries only.
    // 1. Validate mint is pump.fun
    if (!isPumpFunToken(mint.toBase58())) {
      return { status: "skipped", reason: "not_pump_fun", mint };
    }

    // 3. Validate token amount
    if (tokenAmount <= 0n) {
      return { status: "skipped", reason: "invalid_token_amount", mint };
    }

    const user = this.cfg.hotWallet.publicKey;

    // 4. Verify user's token ATA exists and has sufficient tokens
    const associatedUser = getAssociatedTokenAddressSync(mint, user, true);
    const ataInfo = await this.conn.getAccountInfo(associatedUser);
    if (!ataInfo) {
      return { status: "skipped", reason: "ata_does_not_exist", mint };
    }

    // Validate ATA account data is readable (spl-token AccountLayout is 165 bytes)
    if (ataInfo.data.length < 165) {
      return { status: "skipped", reason: "ata_data_invalid", mint };
    }

    if (!ataInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      return { status: "skipped", reason: "ata_wrong_token_program", mint };
    }
    const ataMint = new PublicKey(ataInfo.data.subarray(0, 32));
    if (!ataMint.equals(mint)) {
      return { status: "skipped", reason: "ata_wrong_mint", mint };
    }
    // SPL Account layout: mint 0..31, owner 32..63, amount 64..71.
    const tokenBalance = BigInt(ataInfo.data.readBigUInt64LE(64).toString());
    if (tokenBalance < tokenAmount) {
      return { status: "skipped", reason: "insufficient_token_balance", mint };
    }

    // 5. Preflight — Read bonding curve and simulate
    let bondingCurve: BondingCurveState | null = null;
    try {
      bondingCurve = await readBondingCurve(this.conn, mint);
    } catch (error) {
      return { status: "skipped", reason: "bonding_curve_unreadable", mint };
    }
    if (!bondingCurve) {
      return { status: "skipped", reason: "bonding_curve_unreadable", mint };
    }

    // Check if curve is graduated (completed)
    if (bondingCurve.complete) {
      return { status: "skipped", reason: "bonding_curve_graduated", mint };
    }

    let globalState: GlobalState;
    try {
      globalState = await this.loadGlobal();
      const recipients = resolveFeeRecipients(globalState, bondingCurve.isMayhemMode);
      this.feeRecipient = recipients.feeRecipient;
      this.buybackFeeRecipient = recipients.buybackFeeRecipient;
    } catch {
      return { status: "skipped", reason: "fee_recipient_unresolved", mint };
    }

    // Calculate expected SOL output
    const quote = this.estimateSellQuote(bondingCurve, tokenAmount, {
      feeBps: globalState.feeBasisPoints + globalState.creatorFeeBasisPoints,
      slippagePct: new Decimal(this.cfg.maxSlippagePct),
    });

    // 6. Simulation (if enabled)
    if (this.cfg.preflightSim && simulate) {
      const sim = await simulate(mint, quote.minSolAfterSlippage);
      if (!sim.ok) {
        return { status: "skipped", reason: sim.reason ?? "sim_failed", mint };
      }
    }

    // 7. Build, sign, and send sell transaction via Jito
    try {
      const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
      const sellTx = await buildSellTx(this.conn, {
        mint,
        payer: user,
        feeRecipient: this.feeRecipient!,
        buybackFeeRecipient: this.buybackFeeRecipient!,
        tokenAmount,
        minSolOutputLamports: quote.minSolAfterSlippage,
        blockhash,
      });
      sellTx.sign(this.cfg.hotWallet);

      if (this.cfg.preflightSim) {
        const simulation = await this.conn.simulateTransaction(sellTx, [], false);
        if (simulation.value.err) {
          return {
            status: "failed",
            reason: `sell_preflight_failed:${JSON.stringify(simulation.value.err)}`,
            mint,
          };
        }
      }

      const tip = await this.fees.tipLamports();
      const tipTx = await this.jito.buildTipTx(this.cfg.hotWallet, blockhash, tip);

      // Reserve the mint BEFORE the send so a concurrent signal for the same
      // mint cannot race past the duplicate check.
      this.orders.set(
        mintKey,
        createOrderRecord(mintKey, "sell", tokenAmount),
      );
      await this.persistOrders();

      let bundleId: string;
      try {
        bundleId = await this.jito.sendBundle([tipTx, sellTx]);
        this.orders.set(mintKey, {
          ...this.orders.get(mintKey)!,
          state: "submitted",
          submittedAt: Date.now(),
          placedAt: Date.now(),
          outcome: "in_flight",
          bundleId,
        });
        await this.persistOrders();
      } catch (err) {
        if (err instanceof AmbiguousSendError) {
          // The bundle may be in flight. Keep the reservation so this mint is
          // never re-sniped, and flag it for reconciliation.
          this.orders.set(mintKey, {
            ...this.orders.get(mintKey)!,
            state: "ambiguous",
            outcome: "unknown",
            errorCode: "send_ambiguous",
          });
          await this.persistOrders();
          return { status: "failed", reason: "send_ambiguous", mint };
        }
        // Proven not sent — free the slot.
        this.orders.delete(mintKey);
        await this.persistOrders();
        return {
          status: "failed",
          reason: `send_rejected:${err instanceof Error ? err.message : String(err)}`,
          mint,
        };
      }

      const landed = await this.jito.waitForLanding(bundleId, this.cfg.landingTimeoutMs);

      if (landed.status === "Landed") {
        const txSig = landed.transactions?.[1];
        if (!txSig) {
          this.orders.set(mintKey, {
            ...this.orders.get(mintKey)!,
            state: "ambiguous",
            outcome: "unknown",
            bundleId,
            errorCode: "landed_bundle_missing_transaction_signature",
          });
          await this.persistOrders();
          return { status: "ambiguous", reason: "landed_bundle_missing_transaction_signature", mint };
        }
        const verification = await this.reconcileSellOnChain({
          txSig,
          mint,
          tokenBalanceBefore: tokenBalance,
          expectedSolReceived: quote.minSolAfterSlippage,
        });
        if (!verification.success) {
          this.orders.set(mintKey, {
            ...this.orders.get(mintKey)!,
            state: "ambiguous",
            outcome: "unknown",
            bundleId,
            errorCode: `chain_reconciliation_failed:${verification.error ?? "unknown"}`,
          });
          await this.persistOrders();
          return {
            status: "ambiguous",
            reason: `chain_reconciliation_failed:${verification.error ?? "unknown"}`,
            mint,
          };
        }
        this.orders.set(mintKey, {
          ...this.orders.get(mintKey)!,
          state: verification.actualTokenSpent! < tokenAmount
            ? "partially_filled"
            : "confirmed",
          outcome: "filled",
          bundleId,
          transactionSignature: txSig,
          filledQuantity: verification.actualTokenSpent!.toString(),
          actualSolReceived: verification.actualSolReceived!.toString(),
          feesLamports: verification.fees!.toString(),
        feesSol: baseUnitsToDecimalString(verification.fees!, 9),
          confirmedAt: Date.now(),
          lastReconciledAt: Date.now(),
          reconciliationState: "reconciled",
        });
        await this.persistOrders();
        return {
          status: "confirmed",
          bundleId,
          txSig,
          mint,
          filledAmount: verification.actualTokenSpent!,
          filledPrice: verification.actualPrice!,
          solSpent: verification.actualSolReceived!,
          fees: verification.fees!,
        };
      }

      if (landed.status === "Invalid") {
        // Definitively rejected by the block engine — it cannot land.
        this.orders.delete(mintKey);
        await this.persistOrders();
        return { status: "failed", reason: "bundle_Invalid", mint };
      }

      // Timeout: the bundle can still land after the deadline. Treating this
      // as "failed and free the slot" is what turns one intended sell into two.
      this.orders.set(mintKey, {
        ...this.orders.get(mintKey)!,
        state: "ambiguous",
        outcome: "unknown",
        bundleId,
        errorCode: "bundle_landing_timeout",
      });
      await this.persistOrders();
      return { status: "ambiguous", reason: "bundle_Timeout_unresolved", mint };
    } catch (error) {
      // Proven not sent — free the slot.
      this.orders.delete(mintKey);
      await this.persistOrders();
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        reason: reason.includes("live SELL transaction construction is disabled")
          ? "live_sell_unsupported"
          : `execution_error:${reason}`,
        mint,
      };
    }
  }

  private async loadGlobal(): Promise<GlobalState> {
    const data = (await this.conn.getAccountInfo(globalPda()))?.data;
    if (!data) throw new Error("pump.fun global account not found");
    return parseGlobal(data);
  }
}

function decimalDiv(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) throw new Error("Cannot divide by zero");
  return new Decimal(numerator.toString()).div(denominator.toString()).toFixed();
}

function decimalToBaseUnits(amount: string, decimals: number): bigint {
  const raw = new Decimal(amount)
    .times(new Decimal(10).pow(decimals))
    .toDecimalPlaces(0, Decimal.ROUND_DOWN);
  if (!raw.isFinite() || raw.isNegative()) {
    throw new Error(`Invalid base-unit amount: ${amount}`);
  }
  return BigInt(raw.toFixed(0));
}

function baseUnitsToDecimalString(amount: bigint, decimals: number): string {
  return new Decimal(amount.toString()).div(new Decimal(10).pow(decimals)).toFixed();
}

function isPositiveDecimal(amount: string): boolean {
  try {
    const value = new Decimal(amount);
    return value.isFinite() && value.greaterThan(0);
  } catch {
    return false;
  }
}
