import { useMemo, useState, useEffect } from "react";
import type { ActivityEntry, ActivityType, NormalizedStatus, OrderSide } from "../types/trading";
// No mock tokens — use live data from the API
import { useOrders } from "../hooks/useOrders";
import MarketWatchlist from "../components/MarketWatchlist";
import MarketChart from "../components/MarketChart";
import OrderPanel from "../components/OrderPanel";
import PortfolioSummary from "../components/PortfolioSummary";
import ActivityFeed from "../components/ActivityFeed";
import MayhemBotUi from "../components/MayhemBotUi";
import type { BusyAction } from "../hooks/useSystemStatus";
import "../styles/app.css";
import { api } from "../api/client";
import { normalizeMarketToken, type MarketToken } from "../types/trading";

interface TerminalPageProps {
  status: NormalizedStatus;
  apiOnline: boolean;
  latencyMs: number | null;
  busyAction: BusyAction;
  onStart: () => void;
  onPause: () => void;
  onEmergencyStop: () => void;
  entries: ActivityEntry[];
  onEvent: (message: string, type?: ActivityType) => void;
}

export default function TerminalPage({
  status,
  apiOnline,
  latencyMs,
  busyAction,
  onStart,
  onPause,
  onEmergencyStop,
  entries,
  onEvent,
}: TerminalPageProps) {
  const [selectedTokenId, setSelectedTokenId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [side, setSide] = useState<OrderSide>("BUY");
  const [amount, setAmount] = useState("0.25");
  const [slippage, setSlippage] = useState("1.0");

  const [tokensState, setTokensState] = useState<MarketToken[]>([]);
  const [clearingTokens, setClearingTokens] = useState(false);

  const handleClearTokens = async () => {
    setClearingTokens(true);
    try {
      const result = await api.clearTokens();
      setTokensState([]);
      setSelectedTokenId("");
      onEvent(`CLEARED ${result.cleared} TOKEN(S)`, "SYSTEM");
    } catch (e) {
      onEvent(
        `FAILED TO CLEAR TOKENS: ${e instanceof Error ? e.message : "unknown error"}`,
        "ERROR",
      );
    } finally {
      setClearingTokens(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    let timer: number | null = null;

    async function fetchTokens() {
      try {
        const data = await api.getTokens();
        if (!mounted) return;
        if (Array.isArray(data)) {
          setTokensState(data.map(normalizeMarketToken));
        }
      } catch (e) {
        // ignore
      } finally {
        timer = window.setTimeout(fetchTokens, 5000);
      }
    }

    fetchTokens();

    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const tokens = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? tokensState.filter(
          (token) =>
            token.symbol.toLowerCase().includes(query) ||
            token.name.toLowerCase().includes(query) ||
            (token.address ?? "").toLowerCase().includes(query),
        )
      : tokensState;
  }, [search, tokensState]);

  const selectedToken = tokens.find((token) => token.id === selectedTokenId) ?? tokens[0] ?? null;

  const { submitting, lastOrder, lastError, submitOrder } = useOrders({
    onEvent,
    onConfirmed: () => onEvent("ORDER CONFIRMED", "SUCCESS"),
  });

  const handleSubmit = async () => {
    if (!selectedToken) return;
    await submitOrder({
      side,
      token: selectedToken,
      amountSol: amount,
      slippagePercent: slippage,
      emergencyStop: status.emergencyStop,
    });
  };

  const handleSimulate = () => {
    onEvent("SIMULATED MARKET REFRESH", "INFO");
  };

  return (
    <div className="terminal-page">
      <MayhemBotUi
        status={status}
        apiOnline={apiOnline}
        latencyMs={latencyMs}
        busyAction={busyAction}
        onStart={onStart}
        onPause={onPause}
        onEmergencyStop={onEmergencyStop}
      />

      <div className="terminal-grid">
        <div className="terminal-side">
          <MarketWatchlist
            tokens={tokens}
            selectedId={selectedToken?.id ?? ""}
            onSelect={setSelectedTokenId}
            search={search}
            onSearchChange={setSearch}
            onSimulate={handleSimulate}
            onClear={handleClearTokens}
            clearing={clearingTokens}
          />
          <PortfolioSummary
            positions={[]}
            openPositions={status.openPositions}
            totalTrades={status.totalTrades}
          />
        </div>

        <div className="terminal-main">
          {selectedToken ? (
            <>
              <MarketChart token={selectedToken} />
              <OrderPanel
                token={selectedToken}
            side={side}
            onSideChange={setSide}
            amount={amount}
            onAmountChange={setAmount}
            slippage={slippage}
            onSlippageChange={setSlippage}
            dryRun={status.dryRun}
            modeLabel={status.mode}
            emergencyStop={status.emergencyStop}
            tradingEnabled={status.tradingEnabled}
            submitting={submitting}
            lastOrder={lastOrder}
            lastError={lastError}
            onSubmit={handleSubmit}
          />
            </>
          ) : (
            <div className="panel empty-panel">
              <div className="panel-header">
                <div>
                  <span className="panel-kicker">MARKET</span>
                  <h2>No token selected</h2>
                </div>
              </div>
              <div style={{ padding: 20 }}>Waiting for token feed to populate...</div>
            </div>
          )}
        </div>
      </div>

      <ActivityFeed entries={entries} />
    </div>
  );
}
