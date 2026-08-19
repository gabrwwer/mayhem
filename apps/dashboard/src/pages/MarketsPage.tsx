import { useMemo } from "react";
import { Link } from "react-router-dom";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Stat, StatRow } from "../components/ui/Stat";
import { Badge } from "../components/ui/Badge";
import { AsyncPanelBody, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { STAGE_TONE } from "../types/token";
import { formatCompact, formatCount, formatPrice, shortAddress } from "../lib/format";

/**
 * Markets.
 *
 * There is no market-data endpoint. What the backend can tell us about
 * "markets" is limited to the subset of discovered tokens that reached
 * GRADUATED — i.e. tokens with a real pool. That is what this page shows, and
 * it says so. It is deliberately not a synthesised market overview.
 */
export default function MarketsPage() {
  const { tokens } = useTerminal();

  const graduated = useMemo(
    () => (tokens.data ? tokens.data.filter((t) => t.stage === "GRADUATED") : null),
    [tokens.data],
  );

  const withLiquidity = (graduated ?? []).filter((t) => t.liquidity !== null);
  const totalLiquidity = withLiquidity.reduce((sum, t) => sum + (t.liquidity ?? 0), 0);

  return (
    <PageFrame meta={`${graduated?.length ?? 0} graduated of ${tokens.data?.length ?? 0} tracked`}>
      <div style={{ display: "grid", gap: 8, minHeight: 0 }}>
        <StatRow>
          <Stat
            label="Tracked Tokens"
            value={tokens.data ? String(tokens.data.length) : "—"}
            sub="in the API's discovery map"
            large
          />
          <Stat label="Graduated" value={String(graduated?.length ?? 0)} sub="pool live" />
          <Stat
            label="Reported Liquidity"
            value={
              withLiquidity.length > 0 ? formatCompact(totalLiquidity) : "—"
            }
            sub={`across ${withLiquidity.length} of ${graduated?.length ?? 0} with a value`}
          />
          <Stat
            label="Aggregate Volume"
            value={<Value value={null} format={formatCompact} source="market data service" />}
            sub="no market-data endpoint"
          />
        </StatRow>

        <div className="mh-banner" data-tone="info">
          <span>
            This page is derived from the discovery feed, not from a market-data
            service. It lists tokens the bot has seen reach a live pool. Prices,
            liquidity and volume appear only where the bot enriched the record;
            unenriched fields read N/A rather than being filled from a
            third-party source the backend does not currently query.
          </span>
        </div>

        <Panel title="Graduated Tokens" meta={<Badge tone="info">GET /api/tokens</Badge>}>
          <AsyncPanelBody
            loading={tokens.loading}
            error={tokens.error}
            data={graduated}
            source="GET /api/tokens (stage=GRADUATED)"
            emptyTitle="No graduated tokens"
            emptyDetail="No discovered token has reached the GRADUATED stage in the API's current state."
            onRetry={tokens.refresh}
          >
            {(rows) => (
              <table className="mh-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Mint</th>
                    <th>Pool</th>
                    <th>Stage</th>
                    <th className="num">Price</th>
                    <th className="num">Mkt Cap</th>
                    <th className="num">Liquidity</th>
                    <th className="num">Vol 24h</th>
                    <th className="num">Holders</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.mint}>
                      <td className="mh-mono">{t.symbol}</td>
                      <td className="mh-mono" title={t.mint}>
                        {shortAddress(t.mint, 4, 4)}
                      </td>
                      <td className="mh-mono" title={t.poolAddress ?? ""}>
                        {t.poolAddress ? shortAddress(t.poolAddress, 4, 4) : "—"}
                      </td>
                      <td>
                        <Badge tone={STAGE_TONE[t.stage]}>{t.stage}</Badge>
                      </td>
                      <td className="num">
                        <Value value={t.price} format={(n) => formatPrice(n)} source="bot enrichment" />
                      </td>
                      <td className="num">
                        <Value value={t.marketCap} format={formatCompact} source="bot enrichment" />
                      </td>
                      <td className="num">
                        <Value value={t.liquidity} format={formatCompact} source="bot enrichment" />
                      </td>
                      <td className="num">
                        <Value value={t.volume24h} format={formatCompact} source="bot enrichment" />
                      </td>
                      <td className="num">
                        <Value value={t.holders} format={formatCount} source="bot enrichment" />
                      </td>
                      <td>
                        <Link to={`/token/${t.mint}`} className="mh-btn mh-btn--sm">
                          Inspect
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </AsyncPanelBody>
        </Panel>
      </div>
    </PageFrame>
  );
}
