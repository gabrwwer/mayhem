import { useEffect, useState } from "react";
import PageFrame from "../components/shell/PageFrame";
import Panel from "../components/ui/Panel";
import { Badge } from "../components/ui/Badge";
import { useTerminal } from "../terminal-context";
import { API_BASE } from "../lib/api";

const STORAGE_KEY = "mayhem.terminal.preferences";

interface Preferences {
  /** Require a typed confirmation for destructive actions while LIVE. */
  strictLiveConfirm: boolean;
  /** Suppress the pulsing indicators (independent of OS reduced-motion). */
  reduceMotion: boolean;
}

const DEFAULTS: Preferences = {
  strictLiveConfirm: true,
  reduceMotion: false,
};

function load(): Preferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      strictLiveConfirm: parsed.strictLiveConfirm ?? DEFAULTS.strictLiveConfirm,
      reduceMotion: parsed.reduceMotion ?? DEFAULTS.reduceMotion,
    };
  } catch {
    // A corrupt preference blob must not take the terminal down.
    return DEFAULTS;
  }
}

/**
 * Terminal preferences.
 *
 * Strictly client-side. Nothing here changes bot behaviour — trading
 * parameters live in Config, backed by the bot's .env. Keeping the two
 * separate matters: an operator must never believe a browser preference
 * changed a risk limit.
 */
export default function SettingsPage() {
  const { status, apiOnline } = useTerminal();
  const [prefs, setPrefs] = useState<Preferences>(load);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Storage can be unavailable (private mode, quota). Preferences simply
      // do not persist; the terminal keeps working.
    }
    document.documentElement.dataset.reduceMotion = prefs.reduceMotion ? "true" : "false";
  }, [prefs]);

  return (
    <PageFrame meta="stored in this browser only">
      <div className="mh-dash">
        <div className="span-6">
          <Panel title="Terminal Preferences" padded>
            <div style={{ display: "grid", gap: 12 }}>
              <label className="mh-row" style={{ gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={prefs.strictLiveConfirm}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, strictLiveConfirm: e.target.checked }))
                  }
                  style={{ width: "auto" }}
                />
                <span>
                  <span className="mh-label">Strict LIVE confirmations</span>
                  <div className="mh-field__hint">
                    Require explicit confirmation for destructive actions while the
                    engine is live. Leaving this on is strongly recommended.
                  </div>
                </span>
              </label>

              <label className="mh-row" style={{ gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={prefs.reduceMotion}
                  onChange={(e) => setPrefs((p) => ({ ...p, reduceMotion: e.target.checked }))}
                  style={{ width: "auto" }}
                />
                <span>
                  <span className="mh-label">Reduce motion</span>
                  <div className="mh-field__hint">
                    Suppress pulsing status indicators. The LIVE banner remains
                    visually distinct regardless.
                  </div>
                </span>
              </label>
            </div>
          </Panel>
        </div>

        <div className="span-6">
          <Panel title="Connection" padded>
            <dl className="mh-dl">
              <dt>API base</dt>
              <dd>{API_BASE}</dd>
              <dt>Reachable</dt>
              <dd>{apiOnline ? "YES" : "NO"}</dd>
              <dt>Auth</dt>
              <dd>Bearer token from VITE_API_TOKEN (build-time, never shown)</dd>
              <dt>Engine mode</dt>
              <dd>
                <Badge tone={status.tradingLive ? "bad" : "sim"}>
                  {status.tradingLive ? "LIVE" : status.dryRun ? "DRY RUN" : "UNKNOWN"}
                </Badge>
              </dd>
              <dt>Transport</dt>
              <dd>HTTP polling — no WebSocket channel exists on the API</dd>
            </dl>
          </Panel>
        </div>

        <div className="span-12">
          <div className="mh-banner" data-tone="info">
            <span>
              Preferences on this page affect only this browser. Trading
              behaviour is configured in <strong>Config</strong> and is written
              to the bot&apos;s .env file. API credentials and wallet secrets are
              never read, displayed or stored by the dashboard.
            </span>
          </div>
        </div>
      </div>
    </PageFrame>
  );
}
