import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Stat, StatRow } from "../components/ui/Stat";
import { Badge } from "../components/ui/Badge";
import { EmptyState, NotWired, Unavailable, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { STAGE_TONE } from "../types/token";
import {
  ageLabel,
  formatCompact,
  formatCount,
  formatDateTime,
  formatPercent,
  formatPrice,
  formatSol,
} from "../lib/format";

type Tab = "OVERVIEW" | "LIQUIDITY" | "HOLDERS" | "AUTHORITY" | "ACTIVITY";

const TABS: Tab[] = ["OVERVIEW", "LIQUIDITY", "HOLDERS", "AUTHORITY", "ACTIVITY"];

/**
 * Token intelligence terminal.
 *
 * The spec asks for a candlestick chart, top-50 holder distribution, a live
 * transaction feed and authority status. None of those have a data source: the
 * API keeps no price history, no holder table, no transaction stream and no
 * authority record. Each of those sections therefore states what it needs
 * instead of rendering an empty chart that implies a flat price.
 */
export default function TokenIntelligencePage() {
  const { mint } = useParams<{ mint: string }>();
  const navigate = useNavigate();
  const { tokens, positions, trades } = useTerminal();
  const [tab, setTab] = useState<Tab>("OVERVIEW");

  const token = useMemo(
    () => (mint ? (tokens.data ?? []).find((t) => t.mint === mint) ?? null : null),
    [tokens.data, mint],
  );

  const tokenTrades = useMemo(
    () => (mint ? (trades.data ?? []).filter((t) => t.tokenMint === mint) : []),
    [trades.data, mint],
  );

  const tokenPositions = useMemo(
    () => (mint ? (positions.data ?? []).filter((p) => p.tokenMint === mint) : []),
    [positions.data, mint],
  );

  if (!mint) {
    return (
      <PageFrame>
        <Panel title="Select a token">
          <EmptyState
            title="No token selected"
            detail="Open a token from the Discover scanner, Markets, Positions or Trades to inspect it here."
            source="GET /api/tokens"
          >
            <button type="button" className="mh-btn mh-btn--primary" onClick={() => navigate("/discover")}>
              Open scanner
            </button>
          </EmptyState>
        </Panel>
      </PageFrame>
    );
  }

  if (!token) {
    return (
      <PageFrame meta={mint}>
        <Panel title="Token not found">
          <EmptyState
            title="Not in the discovery map"
            detail={`The API's token map has no record for this mint. It may have been cleared, or the bot never reported it. No data is fabricated for unknown mints.`}
            source="GET /api/tokens"
          >
            <button type="button" className="mh-btn" onClick={() => navigate("/discover")}>
              Back to scanner
            </button>
          </EmptyState>
        </Panel>
      </PageFrame>
    );
  }

  return (
    <PageFrame
      meta={token.mint}
      actions={
        <>
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={`mh-btn${tab === t ? " mh-btn--primary" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </>
      }
    >
      <div style={{ display: "grid", gap: 8, minHeight: 0 }}>
        <StatRow>
          <Stat
            label="Token"
            value={token.symbol}
            sub={token.name ?? "no name reported"}
            large
          />
          <Stat
            label="Stage"
            value={<Badge tone={STAGE_TONE[token.stage]}>{token.stage}</Badge>}
            sub={token.source ? `via ${token.source}` : "source unknown"}
          />
          <Stat
            label="Price"
            value={<Value value={token.price} format={(n) => formatPrice(n)} source="bot enrichment" />}
          />
          <Stat
            label="Liquidity"
            value={<Value value={token.liquidity} format={formatCompact} source="bot enrichment" />}
          />
          <Stat
            label="Market Cap"
            value={<Value value={token.marketCap} format={formatCompact} source="bot enrichment" />}
          />
          <Stat
            label="Holders"
            value={<Value value={token.holders} format={formatCount} source="bot enrichment" />}
          />
          <Stat
            label="Age"
            value={token.ageSec === null ? <Unavailable /> : ageLabel(token.ageSec)}
            sub={token.discoveredAt ? `found ${formatDateTime(token.discoveredAt)}` : ""}
          />
          <Stat
            label="MAYHEM Score"
            value={<Unavailable source="MAYHEM Score service" reason="does not exist" />}
            sub="no scoring backend"
          />
        </StatRow>

        {tab === "OVERVIEW" ? (
          <>
            <Panel title="Price Chart" meta={<Badge tone="muted">not wired</Badge>}>
              <NotWired
                what="Price history"
                needs="an OHLC endpoint — the API stores no time-series price data, so no chart can be drawn"
              />
            </Panel>

            <Panel title="Identity & Enrichment" padded>
              <dl className="mh-dl">
                <dt>Mint</dt>
                <dd>{token.mint}</dd>
                <dt>Name</dt>
                <dd>{token.name ?? <Unavailable source="bot discovery" />}</dd>
                <dt>Pool</dt>
                <dd>{token.poolAddress ?? <Unavailable source="bot discovery" />}</dd>
                <dt>Initial liquidity</dt>
                <dd>
                  <Value
                    value={token.initialLiquidity}
                    format={(n) => formatSol(n, 3)}
                    source="bot discovery"
                  />
                </dd>
                <dt>Volume 24h</dt>
                <dd>
                  <Value value={token.volume24h} format={formatCompact} source="bot enrichment" />
                </dd>
                <dt>Top holder</dt>
                <dd>
                  <Value
                    value={token.topHolderPercent}
                    format={(n) => formatPercent(n)}
                    source="bot enrichment"
                  />
                </dd>
                <dt>Total supply</dt>
                <dd>
                  <Value value={token.totalSupply} format={formatCount} source="pump.fun coins API" />
                </dd>
                <dt>Market cap (USD)</dt>
                <dd>
                  <Value
                    value={token.usdMarketCap}
                    format={(n) => `$${formatCompact(n)}`}
                    source="pump.fun coins API"
                  />
                </dd>
                <dt>Safety score</dt>
                <dd>
                  <Value
                    value={token.riskScore}
                    format={(n) => `${n.toFixed(0)} / 100 (higher = safer, heuristic only)`}
                    source="bot enrichment"
                  />
                </dd>
                <dt>Enrichment note</dt>
                <dd>{token.enrichmentNote ?? <Unavailable source="bot enrichment" />}</dd>
                <dt>Graduated at</dt>
                <dd>
                  {token.graduatedAt ? formatDateTime(token.graduatedAt) : <Unavailable />}
                </dd>
                <dt>Last updated</dt>
                <dd>{token.updatedAt ? formatDateTime(token.updatedAt) : <Unavailable />}</dd>
              </dl>
            </Panel>
          </>
        ) : null}

        {tab === "LIQUIDITY" ? (
          <Panel title="Liquidity Analysis" meta={<Badge tone="muted">not wired</Badge>}>
            <NotWired
              what="Pool-by-pool liquidity"
              needs="a pool inspection endpoint — the API records a single poolAddress with no depth or concentration data"
            />
          </Panel>
        ) : null}

        {tab === "HOLDERS" ? (
          <Panel title="Holder Distribution" meta={<Badge tone="muted">not wired</Badge>}>
            <NotWired
              what="Holder breakdown"
              needs="a holder distribution endpoint — only an aggregate holder count and top-holder percentage are reported, with no per-wallet data"
            />
          </Panel>
        ) : null}

        {tab === "AUTHORITY" ? (
          <Panel title="Authority Status" meta={<Badge tone="muted">not wired</Badge>}>
            <NotWired
              what="Mint, freeze and upgrade authority"
              needs="an authority inspection endpoint — this is a material safety signal and is deliberately not guessed at"
            />
          </Panel>
        ) : null}

        {tab === "ACTIVITY" ? (
          <>
            <Panel title="This Bot's Positions" meta={<Badge tone="ok">GET /api/positions</Badge>}>
              {tokenPositions.length === 0 ? (
                <EmptyState title="No positions in this token" source="GET /api/positions" />
              ) : (
                <table className="mh-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th className="num">Entry</th>
                      <th className="num">Size</th>
                      <th className="num">Unreal. P&L</th>
                      <th>Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokenPositions.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Badge tone={p.status === "OPEN" ? "ok" : "muted"}>{p.status}</Badge>
                        </td>
                        <td className="num">
                          <Value value={p.entryPrice} format={(n) => formatPrice(n)} />
                        </td>
                        <td className="num">
                          <Value value={p.amountSol} format={(n) => formatSol(n, 3)} />
                        </td>
                        <td className="num">
                          <Value value={p.unrealizedPnl} format={(n) => formatSol(n, 4)} />
                        </td>
                        <td className="mh-mono">{formatDateTime(p.openedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title="This Bot's Trades" meta={<Badge tone="ok">GET /api/trades</Badge>}>
              {tokenTrades.length === 0 ? (
                <EmptyState title="No trades in this token" source="GET /api/trades" />
              ) : (
                <table className="mh-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Side</th>
                      <th className="num">Size</th>
                      <th className="num">Price</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokenTrades.map((t) => (
                      <tr key={t.id}>
                        <td className="mh-mono">{formatDateTime(t.createdAt)}</td>
                        <td>
                          <Badge tone={t.side === "BUY" ? "ok" : "warn"}>{t.side}</Badge>
                        </td>
                        <td className="num">
                          <Value value={t.amountSol} format={(n) => formatSol(n, 4)} />
                        </td>
                        <td className="num">
                          <Value value={t.price} format={(n) => formatPrice(n)} />
                        </td>
                        <td>{t.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title="On-chain Transaction Feed" meta={<Badge tone="muted">not wired</Badge>}>
              <NotWired
                what="On-chain transactions"
                needs="a transaction stream endpoint — the API records only this bot's own trades, not third-party activity in the token"
              />
            </Panel>
          </>
        ) : null}
      </div>
    </PageFrame>
  );
}
