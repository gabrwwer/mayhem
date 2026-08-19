import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import type { ActivityType, MarketToken, Order, OrderResponse, OrderSide } from "../types/trading";

export interface OrderInput {
  side: OrderSide;
  token: MarketToken;
  amountSol: string;
  slippagePercent: string;
  emergencyStop: boolean;
}

export type OrderStep = "idle" | "submitting" | "confirmed" | "failed";

export function useOrders(options: {
  onEvent: (message: string, type?: ActivityType) => void;
  onConfirmed: () => void;
}) {
  const { onEvent, onConfirmed } = options;
  const [step, setStep] = useState<OrderStep>("idle");
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const submitting = step === "submitting";

  const submitOrder = useCallback(
    async (input: OrderInput): Promise<boolean> => {
      if (inFlight.current) {
        onEvent("ORDER IGNORED — submission already in progress", "WARNING");
        return false;
      }

      const { side, token } = input;
      const symbol = token.symbol;
      const label = `${side} ${symbol}`;

      onEvent(`${side} CLICKED — ${symbol}`, "TRADE");
      console.info(`[MAYHEM] ${label} clicked`);

      // — Validation pipeline (every rejection is traceable) —
      if (input.emergencyStop) {
        onEvent("ORDER REJECTED — EMERGENCY STOP ACTIVE", "ERROR");
        console.warn("[MAYHEM] Order blocked: emergency stop active");
        return false;
      }

      if (!input.amountSol.trim()) {
        onEvent("ORDER REJECTED — INVALID AMOUNT (empty)", "ERROR");
        return false;
      }
      const numericAmount = Number(input.amountSol);
      if (
        Number.isNaN(numericAmount) ||
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        onEvent("ORDER REJECTED — INVALID AMOUNT", "ERROR");
        console.warn("[MAYHEM] Invalid amount:", input.amountSol);
        return false;
      }

      const numericSlippage = Number(input.slippagePercent);
      if (
        Number.isNaN(numericSlippage) ||
        !Number.isFinite(numericSlippage) ||
        numericSlippage < 0 ||
        numericSlippage > 100
      ) {
        onEvent("ORDER REJECTED — INVALID SLIPPAGE", "ERROR");
        console.warn("[MAYHEM] Invalid slippage:", input.slippagePercent);
        return false;
      }

      onEvent("ORDER VALIDATION PASSED", "INFO");
      console.info("[MAYHEM] Order validation passed");

      inFlight.current = true;
      setStep("submitting");
      setLastError(null);

      onEvent(`POST /api/orders`, "SYSTEM");
      onEvent(`${label} — SUBMITTING ${numericAmount.toFixed(3)} SOL`, "TRADE");

      try {
        const result = await apiFetch<OrderResponse>("/orders", {
          method: "POST",
          body: JSON.stringify({
            side: side.toLowerCase(),
            symbol,
            tokenMint: token.address,
            amountSol: numericAmount,
            price: token.price,
            slippagePercent: numericSlippage,
          }),
        });

        if (result && result.ok === false) {
          const reason = result.error ?? result.message ?? "backend rejected order";
          throw new Error(`Backend returned ok:false — ${reason}`);
        }

        const order = result?.order ?? null;
        const mode = order?.mode ?? result?.mode;
        // Never claim a live transaction unless the backend says so.
        const isPaper = mode ? /dry|paper|sim/i.test(mode) : true;

        if (mounted.current) {
          setLastOrder(order);
          setStep("confirmed");
          onEvent(
            `${label} — ${isPaper ? "PAPER TRADE CONFIRMED" : "ORDER CONFIRMED"}`,
            "SUCCESS",
          );
        }

        const signature = order?.signature ?? result?.signature;
        if (signature) {
          onEvent(
            `${isPaper ? "PAPER SIGNATURE" : "TX SIGNATURE"} — ${signature}`,
            "SUCCESS",
          );
        }

        onEvent("POSITION UPDATED", "SYSTEM");
        if (mounted.current) {
          onConfirmed();
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown order error";
        if (mounted.current) {
          setLastError(message);
          setStep("failed");
        }
        onEvent(`ORDER FAILED — ${message}`, "ERROR");
        console.error("[MAYHEM] Order failed:", error);
        return false;
      } finally {
        inFlight.current = false;
        if (mounted.current) {
          window.setTimeout(
            () => setStep((current) => (current === "confirmed" ? "idle" : current)),
            4000,
          );
        }
      }
    },
    [onEvent, onConfirmed],
  );

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  return { step, submitting, lastOrder, lastError, submitOrder };
}