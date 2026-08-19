import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Badge } from "../components/ui/Badge";
import { AsyncPanelBody, Unavailable, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { useSortableRows, sortableHeader } from "../hooks/useSortableRows";
import { STAGE_TONE, type DiscoveredToken, type TokenStage } from "../types/token";
import {
  ageLabel,
  formatCompact,
  formatCount,
  formatPercent,
  formatPrice,
  shortAddress,
} from "../lib/format";

type SortKey =
  | "symbol"
  | "stage"
  | "price"
  | "liquidity"
  | "marketCap"
  | "volume24h"
  | "holders"
  | "topHolderPercent"
  | "riskScore"
  | "ageSec";

const STAGES: (TokenStage | "ALL")[] = [
  "ALL",
  "DETECTED",
  "LP_ADDED",
  "BONDING_CURVE",
  "GRADUATED",
];

/**
 * Token scanner.
 *
 * Filters are limited to fields the backend actually returns. The spec also
 * asks for volume surge, holder growth, DEX and smart-money filters — none of
 * those exist in the discovery payload, so they are declared as unavailable
 * below rather than rendered as controls that silently do nothing.
 */
export default function DiscoverPage() {
  const { tokens } = useTerminal();

  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<TokenStage | "ALL">("ALL");
  const [minLiquidity, setMinLiquidity] = useState("");
  const [minHolders, setMinHolders] = useState("");
  const [enrichedOnly, setEnrichedOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const rows = tokens.data;
    if (!rows) return null;

    const q = query.trim().toLowerCase();
    const liqFloor = Number.parseFloat(minLiquidity);
    const holderFloor = Number.parseInt(minHolders, 10);

    return rows.filter((t) => {
      if (q && !`${t.symbol} ${t.name ?? ""} ${t.mint}`.toLowerCase().includes(q)) {
        return false;
      }
      if (stage !== "ALL" && t.stage !== stage) return false;

      // A token with no reported liquidity is excluded by a liquidity floor
      // rather than treated as 0 — we do not know that it is below the floor.
      if (Number.isFinite(liqFloor)) {
        if (t.liquidity === null || t.liquidity < liqFloor) return false;
      }
      if (Number.isFinite(holderFloor)) {
        if (t.holders === null || t.holders < holderFloor) return false;
      }
      if (enrichedOnly && t.price === null && t.liquidity === null) return false;

      return true;
    });
  }, [tokens.data, query, stage, minLiquidity, minHolders, enrichedOnly]);

  const accessors: Record<SortKey, (t: DiscoveredToken) => number | string | null> = {
    symbol: (t) => t.symbol,
    stage: (t) => t.stage,
    price: (t) => t.price,
    liquidity: (t) => t.liquidity,
    marketCap: (t) => t.marketCap,
    volume24h: (t) => t.volume24h,
    holders: (t) => t.holders,
    topHolderPercent: (t) => t.topHolderPercent,
    riskScore: (t) => t.riskScore,
    ageSec: (t) => t.ageSec,
  };

  const { sorted, sort, toggle } = useSortableRows(filtered, accessors, {
    key: "ageSec",
    dir: "asc",
  });

  const th = (key: SortKey) => sortableHeader(key, sort, toggle);

  return (
    <PageFrame
      meta={
        <>
          {sorted?.length ?? 0} of {tokens.data?.length ?? 0} tokens · polled every 5s
        </>
      }
      actions={
        <>
          <input
            className="mh-input"
            style={{ width: 200 }}
            placeholder="symbol, name or mint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search tokens"
          />
          <select
            className="mh-select"
            style={{ width: 140 }}
            value={stage}
            onChange={(e) => setStage(e.target.value as TokenStage | "ALL")}
            aria-label="Stage filter"
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s === "ALL" ? "All stages" : s}
              </option>
            ))}
          </select>
          <input
            className="mh-input"
            style={{ width: 110 }}
            placeholder="min liq"
            inputMode="decimal"
            value={minLiquidity}
            onChange={(e) => setMinLiquidity(e.target.value)}
            aria-label="Minimum liquidity"
          />
          <input
            className="mh-input"
            style={{ width: 110 }}
            placeholder="min holders"
            inputMode="numeric"
            value={minHolders}
            onChange={(e) => setMinHolders(e.target.value)}
            aria-label="Minimum holders"
          />
          <button
            type="button"
            className={`mh-btn${enrichedOnly ? " mh-btn--primary" : ""}`}
            onClick={() => setEnrichedOnly((v) => !v)}
            title="Hide tokens the bot has not enriched with price/liquidity yet"
          >
            Enriched only
          </button>
          <button type="button" className="mh-btn" onClick={tokens.refresh}>
            Refresh
          </button>
        </>
      }
      flush
    >
      <div
        style={{
          display: "grid",
          gridTemplateRows: "1fr auto",
          height: "100%",
          minHeight: 0,
        }}
      >
        <Panel
          title="Live Scanner"
          meta={
            tokens.error ? (
              <Badge tone="bad">stale</Badge>
            ) : (
              <Badge tone="info">polling</Badge>
            )
          }
        >
          <AsyncPanelBody
            loading={tokens.loading}
            error={tokens.error}
            data={sorted}
            source="GET /api/tokens"
            emptyTitle="No tokens match"
            emptyDetail="Either the bot has discovered nothing yet, or the active filters exclude everything."
            onRetry={tokens.refresh}
          >
            {(rows) => (
              <table className="mh-table">
                <thead>
                  <tr>
                    <th {...th("symbol")}>Token</th>
                    <th>Mint</th>
                    <th {...th("stage")}>Stage</th>
                    <th className="num" {...th("price")}>
                      Price
                    </th>
                    <th className="num" {...th("marketCap")}>
                      Mkt Cap
                    </th>
                    <th className="num" {...th("liquidity")}>
                      Liquidity
                    </th>
                    <th className="num" {...th("volume24h")}>
                      Vol 24h
                    </th>
                    <th className="num" {...th("holders")}>
                      Holders
                    </th>
                    <th className="num" {...th("topHolderPercent")}>
                      Top Holder
                    </th>
                    {/* Labelled "Safety" because the producer scores
                        higher = safer (enrichment.ts heuristicRiskScore).
                        The previous "Risk" heading inverted its meaning. */}
                    <th
                      className="num"
                      title="Heuristic safety score 0-100, higher = safer. Not a risk model."
                      {...th("riskScore")}
                    >
                      Safety
                    </th>
                    <th className="num" {...th("ageSec")}>
                      Age
                    </th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr
                      key={t.mint}
                      data-clickable="true"
                      data-selected={selected === t.mint ? "true" : undefined}
                      onClick={() => setSelected(t.mint)}
                    >
                      <td>
                        <span className="mh-mono">{t.symbol}</span>
                      </td>
                      <td className="mh-mono" title={t.mint}>
                        {shortAddress(t.mint, 4, 4)}
                      </td>
                      <td>
                        <Badge tone={STAGE_TONE[t.stage]}>{t.stage}</Badge>
                      </td>
                      <td className="num">
                        <Value
                          value={t.price}
                          format={(n) => formatPrice(n)}
                          source="bot enrichment"
                          reason="not enriched"
                        />
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
                      <td className="num">
                        <Value
                          value={t.topHolderPercent}
                          format={(n) => formatPercent(n)}
                          source="bot enrichment"
                        />
                      </td>
                      <td className="num">
                        <Value
                          value={t.riskScore}
                          format={(n) => n.toFixed(0)}
                          source="bot enrichment"
                        />
                      </td>
                      <td className="num">
                        {t.ageSec === null ? <Unavailable /> : ageLabel(t.ageSec)}
                      </td>
                      <td>
                        <Link
                          to={`/token/${t.mint}`}
                          className="mh-btn mh-btn--sm"
                          onClick={(e) => e.stopPropagation()}
                        >
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

        {/* Honest statement of what the scanner cannot filter on. Keeping this
            visible is deliberate: a trader must not assume the absence of a
            column means the absence of the risk. */}
        <div className="mh-banner" data-tone="info" style={{ marginTop: 8 }}>
          <span>
            <strong>Filters unavailable:</strong> volume surge, holder growth,
            DEX source, smart-money accumulation, 1m/5m/1h volume buckets and
            the MAYHEM Score are not produced by the current backend. No
            substitute values are shown. See
            <span className="mh-mono"> docs/MAYHEM_UI_ASSESSMENT.md §4</span>.
          </span>
        </div>
      </div>
    </PageFrame>
  );
}
