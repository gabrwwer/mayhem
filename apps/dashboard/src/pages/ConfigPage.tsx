import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { api, ApiError } from "../api/client";
import type { ApiConfig } from "../types/api";
import { normalizeConfig } from "../types/api";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Badge } from "../components/ui/Badge";
import { LoadingState } from "../components/ui/States";
import { useTerminal } from "../terminal-context";

/** Fields the backend accepts on POST /api/config — must match
 *  CONFIG_FIELDS in apps/api/src/routes.ts. */
type NumericConfigKey = Exclude<keyof ApiConfig, "dryRun" | "tradingEnabled">;

const EDITABLE_FIELDS: NumericConfigKey[] = [
  "maxPositionSol",
  "maxOpenPositions",
  "takeProfitPercent",
  "stopLossPercent",
  "trailingStopPercent",
  "maxHoldSeconds",
  "slippageBps",
  "minLiquiditySol",
  "maxTopHolderPercent",
  "minHolders",
  "maxDailyLossSol",
  "maxExposureSol",
  "maxDrawdownPct",
  "maxConsecutiveLosses",
];

/** Defined outside ConfigPage so it keeps a stable component identity
 *  across renders — if this were declared inside ConfigPage, React would
 *  treat it as a new component type on every keystroke (since the
 *  function reference changes each render) and remount the <input>,
 *  dropping focus after every character typed. */
function NumberField({
  id,
  label,
  hint,
  step,
  min,
  max,
  value,
  onChange,
}: {
  id: NumericConfigKey;
  label: string;
  hint: string;
  step: string;
  min: number;
  max?: number;
  value: number | null;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="mh-field">
      <label className="mh-label" htmlFor={id}>
        {label}
      </label>
      <input
        className="mh-input"
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={value ?? ""}
        onChange={onChange}
      />
      <p className="mh-field__hint">{hint}</p>
    </div>
  );
}

export default function ConfigPage() {
  const { status } = useTerminal();
  const dryRun = status.dryRun;
  const tradingEnabled = status.tradingEnabled;

  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<ApiConfig | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const raw = await api.getConfig();
      const normalized = normalizeConfig(raw);
      setConfig(normalized);
      setFormValues(normalized);
      setError(null);
      setErrorDetails(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const handleSaveConfig = useCallback(async () => {
    if (!formValues) return;

    setSaving(true);
    setSaveResult(null);
    setErrorDetails(null);
    try {
      const payload = Object.fromEntries(
        EDITABLE_FIELDS.filter((key) => formValues[key] !== null).map((key) => [
          key,
          formValues[key] as number,
        ]),
      );
      const result = await api.updateConfig(payload);
      setConfig(formValues);
      setError(null);
      setSaveResult(
        result.message ??
          "Saved. Restart the bot for these changes to take effect.",
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setErrorDetails(err.details ?? null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to save configuration");
      }
    } finally {
      setSaving(false);
    }
  }, [formValues]);

  const handleReset = useCallback(() => {
    setFormValues(config);
    setSaveResult(null);
    setError(null);
    setErrorDetails(null);
  }, [config]);

  const isDirty = useMemo(() => {
    return JSON.stringify(config) !== JSON.stringify(formValues);
  }, [config, formValues]);

  const setField = useCallback(
    (key: NumericConfigKey, isInt: boolean) => (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setFormValues(
        (prev) =>
          ({
            ...(prev ?? {}),
            [key]: raw === "" ? null : isInt ? parseInt(raw, 10) : parseFloat(raw),
          }) as ApiConfig,
      );
    },
    [],
  );

  if (loading) {
    return (
      <PageFrame>
        <LoadingState what="configuration" />
      </PageFrame>
    );
  }

  return (
    <PageFrame
      meta={dryRun ? "editable — engine is in dry run" : "read-only — engine is live"}
      actions={
        <>
          <button
            type="button"
            className="mh-btn mh-btn--primary"
            onClick={() => void handleSaveConfig()}
            disabled={!isDirty || saving || dryRun === false}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="mh-btn" onClick={handleReset} disabled={!isDirty}>
            Reset
          </button>
        </>
      }
    >
      <div className="mh-dash">
        {error && (
          <div className="span-12">
            <div className="mh-banner" data-tone="bad">
              <span>
                {error}
                {errorDetails && errorDetails.length > 0 && (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {errorDetails.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
              </span>
            </div>
          </div>
        )}

        {saveResult && !error && (
          <div className="span-12">
            <div className="mh-banner" data-tone="info">
              <span>{saveResult}</span>
            </div>
          </div>
        )}

        {dryRun === false && (
          <div className="span-12">
            <div className="mh-banner" data-tone="bad">
              <span>
                <strong>Editing disabled.</strong> The engine is LIVE
                (DRY_RUN=false). The API rejects config writes with 409 in this
                state; switch to dry run before changing risk parameters.
              </span>
            </div>
          </div>
        )}

        <div className="span-12">
          <div className="mh-banner" data-tone="info">
            <span>
              These fourteen fields are the complete set the API accepts. RPC,
              WebSocket, monitoring and safety settings described in the UI spec
              are not in the server-side whitelist and are therefore not editable
              here — adding them requires a matching change to{" "}
              <span className="mh-mono">CONFIG_FIELDS</span> in{" "}
              <span className="mh-mono">apps/api/src/routes.ts</span>. Saved
              values are written to the bot&apos;s .env and require a bot restart.
              Credentials are never read or displayed by this page.
            </span>
          </div>
        </div>

        {/* Safety Section */}
        <div className="span-4">
          <Panel
            title="Safety"
            padded
            meta={<Badge tone={dryRun ? "sim" : "bad"}>{dryRun ? "DRY RUN" : "LIVE"}</Badge>}
          >
            <dl className="mh-dl">
              <dt>Dry run</dt>
              <dd>{dryRun ? "TRUE — no real transactions" : "FALSE — real capital"}</dd>
              <dt>Trading enabled</dt>
              <dd>{tradingEnabled ? "TRUE" : "FALSE"}</dd>
            </dl>
            <p className="mh-field__hint" style={{ marginBottom: 0 }}>
              Both are system-wide .env settings and are deliberately not editable
              from the dashboard. Change DRY_RUN in the bot&apos;s .env and restart.
            </p>
          </Panel>
        </div>

        {/* Position Limits */}
        <div className="span-4">
          <Panel title="Position Limits" padded>
          <NumberField
            id="maxPositionSol"
            label="Max Position Size (SOL)"
            hint="Maximum SOL per trade"
            step="0.01"
            min={0}
            max={1000}
            value={formValues?.maxPositionSol ?? null}
            onChange={setField("maxPositionSol", false)}
          />
          <NumberField
            id="maxOpenPositions"
            label="Max Open Positions"
            hint="Maximum concurrent open positions"
            step="1"
            min={1}
            max={100}
            value={formValues?.maxOpenPositions ?? null}
            onChange={setField("maxOpenPositions", true)}
          />
          <NumberField
            id="maxExposureSol"
            label="Max Total Exposure (SOL)"
            hint="Hard cap on total SOL committed across all open positions"
            step="0.01"
            min={0}
            max={100000}
            value={formValues?.maxExposureSol ?? null}
            onChange={setField("maxExposureSol", false)}
          />
          </Panel>
        </div>

        {/* Entry Filters */}
        <div className="span-4">
          <Panel title="Entry Filters" padded>
          <NumberField
            id="minLiquiditySol"
            label="Min Liquidity (SOL)"
            hint="Reject tokens with pool liquidity below this"
            step="0.1"
            min={0}
            max={100000}
            value={formValues?.minLiquiditySol ?? null}
            onChange={setField("minLiquiditySol", false)}
          />
          <NumberField
            id="minHolders"
            label="Min Holders"
            hint="Reject tokens with fewer holders than this"
            step="1"
            min={0}
            max={100000}
            value={formValues?.minHolders ?? null}
            onChange={setField("minHolders", true)}
          />
          <NumberField
            id="maxTopHolderPercent"
            label="Max Top Holder %"
            hint="Reject tokens where the largest holder owns more than this % of supply"
            step="1"
            min={1}
            max={100}
            value={formValues?.maxTopHolderPercent ?? null}
            onChange={setField("maxTopHolderPercent", false)}
          />
          <NumberField
            id="slippageBps"
            label="Max Slippage (bps)"
            hint="100 bps = 1%. Orders that would exceed this are rejected."
            step="1"
            min={0}
            max={5000}
            value={formValues?.slippageBps ?? null}
            onChange={setField("slippageBps", true)}
          />
          </Panel>
        </div>

        {/* Exit Strategy */}
        <div className="span-6">
          <Panel title="Exit Strategy" padded>
          <NumberField
            id="takeProfitPercent"
            label="Take Profit %"
            hint="Close the position once unrealized gain reaches this %"
            step="1"
            min={0}
            max={10000}
            value={formValues?.takeProfitPercent ?? null}
            onChange={setField("takeProfitPercent", false)}
          />
          <NumberField
            id="stopLossPercent"
            label="Stop Loss %"
            hint="Close the position once unrealized loss reaches this % (STOP_LOSS_PCT)"
            step="1"
            min={0}
            max={100}
            value={formValues?.stopLossPercent ?? null}
            onChange={setField("stopLossPercent", false)}
          />
          <NumberField
            id="trailingStopPercent"
            label="Trailing Stop %"
            hint="Trail the peak price by this % before exiting (TRAILING_STOP_PCT)"
            step="1"
            min={0}
            max={100}
            value={formValues?.trailingStopPercent ?? null}
            onChange={setField("trailingStopPercent", false)}
          />
          <NumberField
            id="maxHoldSeconds"
            label="Max Hold Time (seconds)"
            hint="Force-close a position after this long regardless of P&L"
            step="1"
            min={1}
            max={604800}
            value={formValues?.maxHoldSeconds ?? null}
            onChange={setField("maxHoldSeconds", true)}
          />
          </Panel>
        </div>

        {/* Circuit Breaker — non-negotiable. These are not weakened or hidden. */}
        <div className="span-6">
          <Panel
            title="Circuit Breakers"
            padded
            meta={<Badge tone="warn">non-negotiable</Badge>}
          >
          <NumberField
            id="maxDailyLossSol"
            label="Max Daily Loss (SOL)"
            hint="Halt new entries for the day once realized losses reach this"
            step="0.01"
            min={0}
            max={100000}
            value={formValues?.maxDailyLossSol ?? null}
            onChange={setField("maxDailyLossSol", false)}
          />
          <NumberField
            id="maxDrawdownPct"
            label="Max Drawdown %"
            hint="Trip the circuit breaker once equity drawdown reaches this %"
            step="1"
            min={1}
            max={100}
            value={formValues?.maxDrawdownPct ?? null}
            onChange={setField("maxDrawdownPct", false)}
          />
          <NumberField
            id="maxConsecutiveLosses"
            label="Max Consecutive Losses"
            hint="Trip the circuit breaker after this many losing trades in a row"
            step="1"
            min={1}
            max={1000}
            value={formValues?.maxConsecutiveLosses ?? null}
            onChange={setField("maxConsecutiveLosses", true)}
          />
          </Panel>
        </div>
      </div>
    </PageFrame>
  );
}
