import type { MarketToken, Order, OrderSide } from "../types/trading";
import { formatCompact, formatPrice, shortAddress } from "../lib/format";

export interface OrderPanelProps {
  token: MarketToken;
  side: OrderSide;
  onSideChange: (side: OrderSide) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  slippage: string;
  onSlippageChange: (value: string) => void;
  dryRun: boolean;
  modeLabel: string;
  emergencyStop: boolean;
  tradingEnabled: boolean;
  submitting: boolean;
  lastOrder: Order | null;
  lastError: string | null;
  onSubmit: () => void;
}

export default function OrderPanel({
  token,
  side,
  onSideChange,
  amount,
  onAmountChange,
  slippage,
  onSlippageChange,
  dryRun,
  modeLabel,
  emergencyStop,
  tradingEnabled,
  submitting,
  lastOrder,
  lastError,
  onSubmit,
}: OrderPanelProps) {
  const blocked = emergencyStop || !tradingEnabled;

  const blockNote = emergencyStop
    ? "ORDER EXECUTION DISABLED — EMERGENCY STOP ACTIVE"
    : !tradingEnabled
      ? "ORDER EXECUTION DISABLED — TRADING DISABLED BY BACKEND"
      : null;

  const modeClass = dryRun ? "dry" : modeLabel === "LIVE" ? "live" : "unknown";
  const modeText = dryRun
    ? "PAPER TRADE"
    : modeLabel === "LIVE"
      ? "LIVE"
      : "MODE UNKNOWN";

  return (
    <aside className="panel trade-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">EXECUTION</span>
          <h2>ORDER ENTRY</h2>
        </div>
        <span className={`mode-badge ${modeClass}`}>{modeText}</span>
      </div>

      <div className="side-switch">
        <button
          type="button"
          className={`buy ${side === "BUY" ? "active" : ""}`}
          onClick={() => onSideChange("BUY")}
        >
          BUY
        </button>
        <button
          type="button"
          className={`sell ${side === "SELL" ? "active" : ""}`}
          onClick={() => onSideChange("SELL")}
        >
          SELL
        </button>
      </div>

      <div className="token-block">
        <div className="token-block-row">
          <span>SYMBOL</span>
          <strong>{token.symbol}</strong>
        </div>
        <div className="token-block-row">
          <span>PRICE</span>
          <strong>{formatPrice(token.price)}</strong>
        </div>
        <div className="token-block-row">
          <span>MINT</span>
          <strong title={token.address}>{shortAddress(token.address)}</strong>
        </div>
      </div>

      <label className="field">
        <span>SOL AMOUNT</span>
        <div className="input-wrapper">
          <input
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            inputMode="decimal"
            aria-label="SOL amount"
          />
          <span>SOL</span>
        </div>
      </label>

      <label className="field">
        <span>SLIPPAGE %</span>
        <div className="input-wrapper">
          <input
            value={slippage}
            onChange={(event) => onSlippageChange(event.target.value)}
            inputMode="decimal"
            aria-label="Slippage percent"
          />
          <span>%</span>
        </div>
      </label>

      <div className="trade-summary">
        <div>
          <span>PRICE</span>
          <strong>{formatPrice(token.price)}</strong>
        </div>
        <div>
          <span>LIQUIDITY</span>
          <strong>{formatCompact(token.liquidity)}</strong>
        </div>
        <div>
          <span>MAX SLIPPAGE</span>
          <strong>{slippage || "—"}%</strong>
        </div>
        <div>
          <span>EST. COST</span>
          <strong>{amount ? `${Number(amount).toFixed(3)} SOL` : "—"}</strong>
        </div>
      </div>

      {blockNote && <div className="block-note">{blockNote}</div>}

      <button
        type="button"
        className={`execute-button ${side.toLowerCase()}`}
        onClick={onSubmit}
        disabled={submitting || blocked}
      >
        {submitting ? "SUBMITTING..." : `${side} ${token.symbol}`}
      </button>

      {lastError && <div className="order-error">ORDER FAILED — {lastError}</div>}

      {lastOrder && (
        <div className="order-receipt">
          <div className="receipt-title">ORDER CONFIRMED</div>
          <div className="receipt-row">
            <span>ORDER ID</span>
            <strong>{lastOrder.id}</strong>
          </div>
          <div className="receipt-row">
            <span>SIDE</span>
            <strong>{lastOrder.side.toUpperCase()}</strong>
          </div>
          <div className="receipt-row">
            <span>SYMBOL</span>
            <strong>{lastOrder.symbol}</strong>
          </div>
          {typeof lastOrder.tokenAmount === "number" && (
            <div className="receipt-row">
              <span>TOKEN AMOUNT</span>
              <strong>{lastOrder.tokenAmount.toLocaleString()}</strong>
            </div>
          )}
          {typeof lastOrder.amountSol === "number" && (
            <div className="receipt-row">
              <span>SOL AMOUNT</span>
              <strong>{lastOrder.amountSol.toFixed(3)} SOL</strong>
            </div>
          )}
          {typeof lastOrder.price === "number" && (
            <div className="receipt-row">
              <span>PRICE</span>
              <strong>{formatPrice(lastOrder.price)}</strong>
            </div>
          )}
          {lastOrder.signature && (
            <div className="receipt-row">
              <span>SIGNATURE</span>
              <strong title={lastOrder.signature}>
                {shortAddress(lastOrder.signature, 10, 8)}
              </strong>
            </div>
          )}
          <div className="receipt-row">
            <span>MODE</span>
            <strong>{dryRun ? "PAPER" : lastOrder.mode ?? modeLabel}</strong>
          </div>
        </div>
      )}
    </aside>
  );
}