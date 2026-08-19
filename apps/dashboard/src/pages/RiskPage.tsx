import type { ReactNode } from "react";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Meter, Stat, StatRow } from "../components/ui/Stat";
import { Badge } from "../components/ui/Badge";
import { Unavailable, Value } from "../components/ui/States";
import { useTerminal } from "../terminal-context";
import { usePolledResource } from "../hooks/usePolledResource";
import { normalizeConfig } from "../types/api";
import { formatPercent, formatSol } from "../lib/format";

type Verdict = "SAFE" | "WARNED" | "BLOCKED" | "UNKNOWN";

const VERDICT_TONE: Record<Verdict, "ok" | "warn" | "bad" | "muted"> = {
  SAFE: "ok",
  WARNED: "warn",
  BLOCKED: "bad",
  UNKNOWN: "muted",
};

interface Limit {
  metric: string;
  limit: number | null;
  current: number | null;
  format: (n: number) => string;
  /** Where `current` comes from, or what is missing. */
  note: string;
}

/**
 * Verdict is derived only when both sides of the comparison are real numbers.
 * A missing current value yields UNKNOWN, never SAFE — the most dangerous
 * possible default here would be a green badge on an unmeasured limit.
 */
function verdictFor(limit: number | null, current: number | null): Verdict {
  if (limit === null || current === null || limit <= 0) return "UNKNOWN";
  const ratio = current / limit;
  if (ratio >= 1) return "BLOCKED";
  if (ratio >= 0.8) return "WARNED";
  return "SAFE";
}

export default function RiskPage() {
  const { positions, status } = useTerminal();

  const config = usePolledResource({
    path: "/config",
    normalize: normalizeConfig,
    intervalMs: 15_000,
  });

  const open = (positions.data ?? []).filter((p) => p.status === "OPEN");
  const exposureKnown = open.every((p) => p.amountSol !== null);
  const exposure = exposureKnown
    ? open.reduce((sum, p) => sum + (p.amountSol ?? 0), 0)
    : null;

  const largestPosition = exposureKnown
    ? open.reduce((max, p) => Math.max(max, p.amountSol ?? 0), 0)
    : null;

  const cfg = config.data;

  const limits: Limit[] = [
    {
      metric: "Total exposure",
      limit: cfg?.maxExposureSol ?? null,
      current: exposure,
      format: (n) => formatSol(n, 3),
      note: exposureKnown
        ? "summed from open positions"
        : "a position reports no amountSol",
    },
    {
      metric: "Largest single position",
      limit: cfg?.maxPositionSol ?? null,
      current: largestPosition,
      format: (n) => formatSol(n, 3),
      note: exposureKnown ? "max of open positions" : "position size unavailable",
    },
    {
      metric: "Open positions",
      limit: cfg?.maxOpenPositions ?? null,
      current: open.length,
      format: (n) => n.toFixed(0),
      note: "counted from GET /api/positions",
    },
    {
      metric: "Daily loss",
      limit: cfg?.maxDailyLossSol ?? null,
      current: null,
      format: (n) => formatSol(n, 3),
      note: "no daily P&L bucket exists — requires GET /api/risk",
    },
    {
      metric: "Drawdown",
      limit: cfg?.maxDrawdownPct ?? null,
      current: null,
      format: (n) => formatPercent(n),
      note: "requires equity snapshots — GET /api/portfolio/equity",
    },
    {
      metric: "Consecutive losses",
      limit: cfg?.maxConsecutiveLosses ?? null,
      current: null,
      format: (n) => n.toFixed(0),
      note: "not exposed by the API — requires GET /api/risk",
    },
    {
      metric: "Min pool liquidity",
      limit: cfg?.minLiquiditySol ?? null,
      current: null,
      format: (n) => formatSol(n, 2),
      note: "entry gate, no current aggregate to compare against",
    },
    {
      metric: "Slippage budget (bps)",
      limit: cfg?.slippageBps ?? null,
      current: null,
      format: (n) => n.toFixed(0),
      note: "realised slippage is not recorded per trade",
    },
  ];

  const measured = limits.filter((l) => l.current !== null && l.limit !== null);
  const worst = measured.reduce<Verdict>((acc, l) => {
    const v = verdictFor(l.limit, l.current);
    if (v === "BLOCKED") return "BLOCKED";
    if (v === "WARNED" && acc !== "BLOCKED") return "WARNED";
    return acc === "UNKNOWN" ? "SAFE" : acc;
  }, "UNKNOWN");

  return (
    <PageFrame
      meta={
        config.error
          ? "config unavailable"
          : `${measured.length} of ${limits.length} limits measurable`
      }
    >
      <div style={{ display: "grid", gap: 8, minHeight: 0 }}>
        <StatRow>
          <Stat
            label="Overall"
            value={worst}
            tone={VERDICT_TONE[worst]}
            sub={`${measured.length}/${limits.length} limits have a current value`}
            large
          />
          <Stat
            label="Exposure"
            value={
              exposure === null ? (
                <Unavailable source="GET /api/positions" reason="missing amountSol" />
              ) : (
                formatSol(exposure, 3)
              )
            }
            sub={
              cfg?.maxExposureSol != null ? `cap ${formatSol(cfg.maxExposureSol, 3)}` : "cap N/A"
            }
          />
          <Stat
            label="Open Positions"
            value={String(open.length)}
            sub={cfg?.maxOpenPositions != null ? `max ${cfg.maxOpenPositions}` : "max N/A"}
          />
          <Stat
            label="Circuit Breakers"
            value={status.emergencyStop ? "TRIPPED" : "ARMED"}
            tone={status.emergencyStop ? "bad" : "ok"}
            sub="emergency stop latch"
          />
          <Stat
            label="Mode"
            value={status.tradingLive ? "LIVE" : status.dryRun ? "DRY RUN" : "UNKNOWN"}
            tone={status.tradingLive ? "bad" : status.dryRun ? "info" : "warn"}
            sub={status.tradingLive ? "real capital at risk" : "no capital at risk"}
          />
        </StatRow>

        <div className="mh-banner" data-tone="warn">
          <span>
            <strong>Partial risk picture.</strong> Configured limits come from{" "}
            <span className="mh-mono">GET /api/config</span>, but the API exposes
            no current-value endpoint. Daily loss, drawdown, consecutive losses
            and realised slippage cannot be measured here and are shown as N/A
            rather than estimated. The bot&apos;s own risk engine still enforces
            all of them at execution time — this page is a monitor, not the
            control.
          </span>
        </div>

        <Panel
          title="Limits vs Current"
          meta={<Badge tone={config.error ? "bad" : "ok"}>GET /api/config</Badge>}
        >
          <table className="mh-table">
            <thead>
              <tr>
                <th>Risk Metric</th>
                <th className="num">Limit</th>
                <th className="num">Current</th>
                <th style={{ width: 160 }}>Utilisation</th>
                <th>Verdict</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {limits.map((l) => {
                const verdict = verdictFor(l.limit, l.current);
                let utilisation: ReactNode = (
                  <Unavailable reason="current value not measurable" />
                );
                if (l.limit !== null && l.current !== null && l.limit > 0) {
                  utilisation = (
                    <div className="mh-row" style={{ gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Meter current={l.current} limit={l.limit} />
                      </div>
                      <span className="mh-mono" style={{ fontSize: "var(--fs-micro)" }}>
                        {((l.current / l.limit) * 100).toFixed(0)}%
                      </span>
                    </div>
                  );
                }

                return (
                  <tr key={l.metric}>
                    <td>{l.metric}</td>
                    <td className="num">
                      <Value value={l.limit} format={l.format} source="GET /api/config" />
                    </td>
                    <td className="num">
                      <Value value={l.current} format={l.format} reason={l.note} />
                    </td>
                    <td>{utilisation}</td>
                    <td>
                      <Badge tone={VERDICT_TONE[verdict]}>{verdict}</Badge>
                    </td>
                    <td className="mh-truncate" style={{ color: "var(--text-mute)" }}>
                      {l.note}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel title="Exit Controls" padded>
          <dl className="mh-dl">
            <dt>Stop loss</dt>
            <dd>
              <Value
                value={cfg?.stopLossPercent ?? null}
                format={(n) => `${formatPercent(n)} (STOP_LOSS_PCT)`}
                source="GET /api/config"
              />
            </dd>
            <dt>Take profit</dt>
            <dd>
              <Value
                value={cfg?.takeProfitPercent ?? null}
                format={(n) => `${formatPercent(n)} (TAKE_PROFIT_PERCENT)`}
                source="GET /api/config"
              />
            </dd>
            <dt>Trailing stop</dt>
            <dd>
              <Value
                value={cfg?.trailingStopPercent ?? null}
                format={(n) => `${formatPercent(n)} (TRAILING_STOP_PCT)`}
                source="GET /api/config"
              />
            </dd>
            <dt>Max hold</dt>
            <dd>
              <Value
                value={cfg?.maxHoldSeconds ?? null}
                format={(n) => `${n.toFixed(0)}s (MAX_HOLD_SECONDS)`}
                source="GET /api/config"
              />
            </dd>
            <dt>Top holder cap</dt>
            <dd>
              <Value
                value={cfg?.maxTopHolderPercent ?? null}
                format={(n) => `${formatPercent(n)} (MAX_TOP_HOLDER_PERCENT)`}
                source="GET /api/config"
              />
            </dd>
            <dt>Min holders</dt>
            <dd>
              <Value
                value={cfg?.minHolders ?? null}
                format={(n) => `${n.toFixed(0)} (MIN_HOLDERS)`}
                source="GET /api/config"
              />
            </dd>
          </dl>
        </Panel>
      </div>
    </PageFrame>
  );
}
