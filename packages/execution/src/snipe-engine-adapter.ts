import { PublicKey } from "@solana/web3.js";
import type { QuoteResult } from "@mayhem/solana";
import { SnipeEngine, SnipeResult } from "./engine";
import Decimal from "decimal.js";

export interface ExecutionLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface AdapterExecutionResult {
  signature: string;
  status: "confirmed" | "failed" | "pending" | "expired";
  error?: string;
  fees?: string;
  feesLamports?: bigint;
  filledInputAmount?: string;
  filledOutputAmount?: string;
  filledInputRawAmount?: bigint;
  filledOutputRawAmount?: bigint;
}

const SOL_DECIMALS = 9;
const PUMP_TOKEN_DECIMALS = 6;

/**
 * Translation boundary for the live engine. It intentionally returns null
 * when SnipeEngine has no confirmed chain signature; MayhemEngine treats that
 * as not filled and cannot create a position from it.
 */
export class SnipeEngineAdapter {
  constructor(
    private readonly snipeEngine: SnipeEngine,
    private readonly logger: ExecutionLogger,
  ) {}

  get engine(): SnipeEngine {
    return this.snipeEngine;
  }

  async quoteSell(_tokenMint: string, _quantity: string): Promise<QuoteResult> {
    throw new Error("live sell quoting is not available through SnipeEngine");
  }

  getPortfolioEquityLamports(): bigint {
    throw new Error("live portfolio equity requires an on-chain balance query");
  }

  async executePumpFunBuy(
    mint: string,
    amountSol: string,
  ): Promise<AdapterExecutionResult | null> {
    try {
      const result = await this.snipeEngine.executePumpFunBuy(mint, amountSol);
      return this.translate(result, mint, "buy");
    } catch (error) {
      this.logger.error("LIVE_BUY_ADAPTER_ERROR", {
        mint,
        amountSol,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async executePumpFunSell(
    mint: string,
    amountTokens: string,
  ): Promise<AdapterExecutionResult | null> {
    try {
      if (!isPositiveDecimal(amountTokens)) return null;
      const result = await this.snipeEngine.executePumpFunSell(
        new PublicKey(mint),
        decimalToBaseUnits(amountTokens, PUMP_TOKEN_DECIMALS),
      );
      return this.translate(result, mint, "sell");
    } catch (error) {
      this.logger.error("LIVE_SELL_ADAPTER_ERROR", {
        mint,
        amountTokens,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private translate(
    result: SnipeResult,
    mint: string,
    side: "buy" | "sell",
  ): AdapterExecutionResult | null {
    if (result.status !== "confirmed") {
      this.logger.error("LIVE_ORDER_NOT_CONFIRMED", {
        mint,
        side,
        status: result.status,
        reason: result.reason,
      });
      return null;
    }

    this.logger.info("LIVE_ORDER_CONFIRMED", {
      mint,
      side,
      txSig: result.txSig,
      filledAmount: result.filledAmount.toString(),
      fees: result.fees.toString(),
    });
    return {
      signature: result.txSig,
      status: "confirmed",
      fees: baseUnitsToDecimalString(result.fees, SOL_DECIMALS),
      feesLamports: result.fees,
      ...(side === "buy"
        ? {
            filledInputAmount: baseUnitsToDecimalString(result.solSpent, SOL_DECIMALS),
            filledOutputAmount: baseUnitsToDecimalString(result.filledAmount, PUMP_TOKEN_DECIMALS),
            filledInputRawAmount: result.solSpent,
            filledOutputRawAmount: result.filledAmount,
          }
        : {
            filledInputAmount: baseUnitsToDecimalString(result.filledAmount, PUMP_TOKEN_DECIMALS),
            filledOutputAmount: baseUnitsToDecimalString(result.solSpent, SOL_DECIMALS),
            filledInputRawAmount: result.filledAmount,
            filledOutputRawAmount: result.solSpent,
          }),
    };
  }
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
