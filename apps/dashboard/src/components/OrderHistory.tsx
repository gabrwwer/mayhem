import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../lib/api";
import type { Order } from "../types/trading";
import { formatDateTime, formatPrice, shortAddress } from "../lib/format";

type HistoryState = "probing" | "available" | "unavailable";

export default function OrderHistory() {
  const [state, setState] = useState<HistoryState>("probing");
  const [orders, setOrders] = useState<Order[]>([]);
  const [note, setNote] = useState<string | null>(null);

  // Probe: integrate GET /api/orders if it exists; otherwise show a
  // structured "unavailable" state. Never invents an endpoint.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await apiFetch<unknown>("/orders");
        if (cancelled) return;
        if (Array.isArray(data)) {
          setOrders(data as Order[]);
          setState("available");
        } else {
          setState("unavailable");
          setNote(
            "GET /api/orders returned a non-array response — history unavailable",
          );
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setState("unavailable");
          setNote(
            "Backend does not expose GET /api/orders. Panel is ready for future connection.",
          );
        } else {
          setState("unavailable");
          setNote(error instanceof Error ? error.message : "History unavailable");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel history-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">EXECUTION LOG</span>
          <h2>ORDER HISTORY</h2>
        </div>
        <span className="live-indicator">
          {state === "probing"
            ? "PROBING..."
            : state === "available"
              ? `${orders.length} RECORDS`
              : "UNAVAILABLE"}
        </span>
      </div>

      {state === "probing" && (
        <div className="history-empty">
          <strong>LOADING ORDER HISTORY...</strong>
        </div>
      )}

      {state === "unavailable" && (
        <div className="history-unavailable">
          <strong>ORDER HISTORY UNAVAILABLE</strong>
          <p>{note}</p>
        </div>
      )}

      {state === "available" && orders.length === 0 && (
        <div className="history-empty">
          <strong>NO ORDER HISTORY</strong>
        </div>
      )}

      {state === "available" && orders.length > 0 && (
        <div className="history-table">
          <div className="history-head">
            <span>TIME</span>
            <span>SIDE</span>
            <span>TOKEN</span>
            <span>AMOUNT</span>
            <span>PRICE</span>
            <span>STATUS</span>
            <span>MODE</span>
            <span>SIGNATURE</span>
          </div>

          {orders.map((order) => (
            <div className="history-row" key={order.id}>
              <span>{formatDateTime(order.createdAt ?? order.time ?? null)}</span>
              <span className={order.side?.toUpperCase() === "BUY" ? "positive" : "negative"}>
                {order.side?.toUpperCase() ?? "—"}
              </span>
              <span>{order.symbol ?? shortAddress(order.tokenMint)}</span>
              <span>
                {typeof order.amountSol === "number"
                  ? `${order.amountSol.toFixed(3)} SOL`
                  : "—"}
              </span>
              <span>
                {typeof order.price === "number" ? formatPrice(order.price) : "—"}
              </span>
              <span>{order.status?.toUpperCase() ?? "—"}</span>
              <span>{order.mode ?? "—"}</span>
              <span title={order.signature}>
                {order.signature ? shortAddress(order.signature, 8, 6) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}