import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Stat, StatRow } from "../components/ui/Stat";
import { Badge } from "../components/ui/Badge";
import { EmptyState, NotWired, Unavailable, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { formatCount, formatSignedSol, formatSol, shortAddress } from "../lib/format";

export default function PortfolioPage() {
  const { balance, telemetry, positions, status } = useTerminal();

  const tokenHoldings = Object.entries(balance.data?.tokens ?? {});
  const open = (positions.data ?? []).filter((p) => p.status === "OPEN");
  const wins = telemetry.data?.winCount ?? null;
  const losses = telemetry.data?.lossCount ?? null;

  return (
    <PageFrame meta={status.dryRun ? "DRY RUN — balances are simulated" : "live balances"}>
      <div style={{ display: "grid", gap: 8, minHeight: 0 }}>
        <StatRow>
          <Stat
            label="SOL Balance"
            value={
              <Value value={balance.data?.sol ?? null} format={(n) => formatSol(n, 4)} source="GET /api/balance" />
            }
            sub={status.dryRun ? "simulated (DRY_RUN)" : "on-chain, cached 5s"}
            large
          />
          <Stat
            label="Token Holdings"
            value={balance.data ? String(tokenHoldings.length) : <Unavailable source="GET /api/balance" />}
            sub="distinct mints with a non-zero balance"
          />
          <Stat
            label="Realised P&L"
            value={
              <Value
                value={telemetry.data?.totalPnl ?? null}
                format={(n) => formatSignedSol(n)}
                source="GET /api/telemetry"
              />
            }
            tone={
              telemetry.data?.totalPnl == null ? undefined : telemetry.data.totalPnl >= 0 ? "ok" : "bad"
            }
          />
          <Stat
            label="Win Rate"
            value={telemetry.data?.winRate ?? <Unavailable source="GET /api/telemetry" />}
            sub={
              wins !== null && losses !== null ? `${wins}W / ${losses}L` : "counts unavailable"
            }
          />
          <Stat
            label="Open Positions"
            value={positions.data ? String(open.length) : <Unavailable source="GET /api/positions" />}
          />
          <Stat
            label="Total Portfolio Value"
            value={<Unavailable source="GET /api/portfolio/equity" reason="not implemented" />}
            sub="requires token valuation + equity snapshots"
          />
        </StatRow>

        <Panel title="Equity Curve" meta={<Badge tone="muted">not wired</Badge>}>
          <NotWired
            what="Equity history"
            needs="GET /api/portfolio/equity, backed by the equity_snapshots table"
          />
        </Panel>

        <Panel
          title="Token Holdings"
          meta={<Badge tone={balance.error ? "bad" : "ok"}>GET /api/balance</Badge>}
        >
          {balance.error ? (
            <EmptyState title="Balance unavailable" detail={balance.error} source="GET /api/balance" />
          ) : tokenHoldings.length === 0 ? (
            <EmptyState
              title="No token balances"
              detail={
                status.dryRun
                  ? "The engine is in dry run, so no on-chain token accounts are queried."
                  : "The wallet holds no SPL token balances, or the RPC query returned none."
              }
              source="GET /api/balance"
            />
          ) : (
            <table className="mh-table">
              <thead>
                <tr>
                  <th>Mint</th>
                  <th className="num">Amount</th>
                  <th className="num">Price</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {tokenHoldings.map(([mint, amount]) => (
                  <tr key={mint}>
                    <td className="mh-mono" title={mint}>
                      {shortAddress(mint, 6, 6)}
                    </td>
                    <td className="num">{formatCount(amount)}</td>
                    {/* /api/balance returns raw amounts only. Pricing token
                        holdings requires a quote source that the API does not
                        expose, so value is not computed. */}
                    <td className="num">
                      <Unavailable source="quote service" reason="no pricing endpoint" />
                    </td>
                    <td className="num">
                      <Unavailable source="quote service" reason="no pricing endpoint" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="mh-banner" data-tone="info">
          <span>
            Total portfolio value and the equity curve require an endpoint that
            values token holdings and reads{" "}
            <span className="mh-mono">equity_snapshots</span>. The data exists in
            Postgres but is not served by the API, so no aggregate value is
            displayed rather than a partial sum that would understate the
            portfolio.
          </span>
        </div>
      </div>
    </PageFrame>
  );
}
