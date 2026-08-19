# MAYHEM UI — Stage 1 & 2 Implementation Notes

Date: 2026-08-17
Companion to `docs/MAYHEM_UI_ASSESSMENT.md`.

---

## ⚠️ Not yet verified

**`pnpm typecheck`, `pnpm build` and the test suite have NOT been run.** The
sandbox Linux environment failed to start in this session, so no command could
be executed. Everything below was written and reviewed by inspection only.

Before trusting this:

```bash
cd C:\dev\mayhem\mq
pnpm install            # required — react-router-dom is a new dependency
pnpm typecheck
pnpm build
pnpm test
```

`react-router-dom@^6.26.2` was added to `apps/dashboard/package.json`. The app
will not build until `pnpm install` is run.

---

## What changed

### New — design system

| File | Purpose |
|---|---|
| `src/styles/theme.css` | All colour, density, typography and geometry tokens, plus primitives (panel, table, badge, dot, button, input, meter, dialog, empty/error states). Near-black surfaces, electric blue primary, cyan secondary, 2px radii, 26px table rows. **No hardcoded hex belongs outside this file.** |
| `src/styles/shell.css` | Fixed-viewport shell grid, status bar, nav rail, page frame, 12-column dashboard grid, responsive rules down to mobile without collapsing table density. |

The previous palette (`#070b15` navy, `#6366f1` indigo, 24px radii, 18px
padding) was the generic-SaaS look the directive rejects and has been replaced.
`src/styles/app.css` and `src/styles/terminal.css` are no longer imported.

### New — UI primitives

- `src/components/ui/Panel.tsx` — panel chrome with independently scrolling body.
- `src/components/ui/Badge.tsx` — `Badge` and `Dot`, semantic tones only.
- `src/components/ui/Stat.tsx` — `Stat`, `StatRow`, `Meter` (current vs limit).
- `src/components/ui/States.tsx` — **the data-integrity layer**: `Unavailable`,
  `Value`, `EmptyState`, `NotWired`, `LoadingState`, `ErrorState`,
  `AsyncPanelBody`.
- `src/components/ConfirmDialog.tsx` — native `<dialog>` confirmation for
  destructive actions.

`Value` renders a number only when it is finite; otherwise it renders `N/A`
with a hover title naming the missing endpoint. This is the mechanism that
enforces the directive's data-integrity rule.

### New — shell and routing

- `src/navigation.ts` — canonical registry of all 13 sections. The rail, the
  router and every page header read from it, so they cannot drift.
- `src/components/shell/StatusBar.tsx` — persistent global bar: branding,
  Solana Mainnet, API reachability, API round-trip, RPC, WebSocket, wallet,
  engine state, **DRY RUN / LIVE**, emergency stop, settings.
- `src/components/shell/NavRail.tsx` — persistent grouped navigation via
  `NavLink`, so the active item is derived from the URL.
- `src/components/shell/PageFrame.tsx` — section chrome.
- `src/terminal-context.ts` — shared polled state above the router, so moving
  between sections does not reset tables or restart polling.
- `src/App.tsx`, `src/main.tsx` — rewritten around `BrowserRouter`.

**DRY RUN vs LIVE.** LIVE is red, pulsing, carries a red rule across the entire
status bar, and reads `● LIVE — REAL CAPITAL`. DRY RUN is violet and reads
`◐ DRY RUN`. An unreadable flag reads `? MODE UNKNOWN` in amber — it is never
assumed to be dry run. The distinction uses `status.tradingLive`, which
`normalizeStatus` re-derives client-side as `tradingEnabled && !dryRun`, so a
backend gating bug cannot make a live engine look safe.

### New — data layer

- `src/hooks/usePolledResource.ts` — polling with honest failure semantics:
  `data` stays `null` until real data arrives, a failed poll sets `error`
  without wiping the last good value, polling backs off while the tab is hidden,
  and `optional: true` turns a 404 into an explicit "not implemented" message.
- `src/hooks/useSortableRows.ts` — table sorting with **null-last** ordering in
  both directions, so an unmeasured metric never sorts as if it were zero.
- `src/types/token.ts` — canonical `DiscoveredToken`. **Every metric is
  `number | null`.**
- `src/types/health.ts` — the written contract for `GET /api/health/components`,
  authored ahead of the endpoint so the UI codes against a documented
  requirement rather than an assumption.
- `src/lib/format.ts` — added `formatSol`, `formatSignedSol`, `formatUsd`,
  `formatCount`, `formatMs`, `formatPercent`, `formatLogTime`, `elapsedSince`.

### Removed — fabricated data

`src/hooks/useMarket.ts` and `src/data/market.ts` contained two hardcoded fake
token lists (MAYHEM, ANARCHY, QUANT, VOID, ROCKET) with invented prices,
liquidity, holder counts and risk scores, rendered with no DEMO marker. Both are
now tombstones that throw or export an empty array, following the convention
already set by `apps/api/src/app.ts`. Neither had any importer, so nothing
broke.

The old normalizer coerced missing metrics to `0`. That turned "we do not know
the liquidity" into "the liquidity is zero" — a materially different and
potentially trade-influencing claim. `normalizeDiscoveredToken` preserves
`null`.

### Sections implemented

| Section | Route | State |
|---|---|---|
| Dashboard | `/` | Wired: portfolio band, open positions, discovery feed, activity. Alerts panel states it has no source. |
| Discover | `/discover` | Wired: sortable/filterable scanner over `/api/tokens`. Filters limited to real fields; a banner names the filters that have no backend. |
| Markets | `/markets` | Derived from graduated discoveries. States it is not a market-data service. |
| Intelligence | `/token/:mint` | Wired: identity, enrichment, this bot's positions and trades. Chart / holders / authority / tx feed each state what they need. |
| Positions | `/positions` | Wired: full table, confirmation dialog for close. Modify and partial close disabled with a reason. |
| Trades | `/trades` | Wired: `/api/trades`, Solscan links. |
| Portfolio | `/portfolio` | Wired: balances + telemetry. Equity curve and total value declared unavailable. |
| Risk | `/risk` | Limits from `/api/config`; exposure, largest position and open count derived from `/api/positions`. Daily loss, drawdown, consecutive losses, slippage declared unmeasurable. |
| Alerts | `/alerts` | Shows the rejection feed, explicitly labelled as *not* the alert stream. |
| Activity | `/activity` | Wired to the session buffer, banner-labelled as session-scoped. |
| System | `/system` | Component table renders N/A per component until the endpoint exists. Execution telemetry is wired. |
| Config | `/config` | Existing logic preserved verbatim; restyled and moved into the shell. |
| Settings | `/settings` | Client-only preferences in localStorage. |

---

## Data-integrity decisions worth reviewing

These are places where showing *something* would have been easy and wrong.

1. **Risk verdicts.** A limit with no measurable current value renders
   `UNKNOWN`, never `SAFE`. A green badge on an unmeasured limit is the most
   dangerous possible default on that page.
2. **Exposure totals.** If any open position is missing `amountSol`, the total
   is not shown at all — a partial sum would understate real exposure.
3. **Scanner liquidity filter.** A token with no reported liquidity is excluded
   by a liquidity floor rather than treated as `0`; we do not know it is below
   the floor.
4. **Per-position stop / take-profit / trailing.** Left as N/A rather than
   filled from global config, because global config values would imply
   per-position stops that may not match what the engine will actually do.
5. **RPC / WebSocket status.** Shown as N/A, not green. The API being reachable
   says nothing about whether the Geyser stream is connected.
6. **Alerts.** An empty alerts panel reads as "nothing has gone wrong", so the
   page states outright that no alert stream exists.
7. **MAYHEM Score.** Does not exist anywhere in the backend. Every score cell
   says so. The bot's `riskScore` is a different, inverted metric and is
   labelled as such.

---

## Not done

### Stage 3 — read-only endpoints (approved, not started)

In priority order:

1. `GET /api/risk` — current exposure, daily P&L, drawdown, consecutive losses
   vs configured limits, with allowed/warned/blocked verdicts.
2. `GET /api/health/components` — contract already written in
   `apps/dashboard/src/types/health.ts`; implementing it populates the System
   console with **no further UI changes**.
3. `GET /api/events` — persisted activity/alert store, replacing the
   session-only client buffer and giving the Alerts page a real source.
4. `GET /api/portfolio/equity` — equity curve from `equity_snapshots`.

### Stage 4 — execution API (approved in principle, deliberately held)

You approved "full stack including execution API". I have **not** written it,
and I want an explicit second confirmation before I do, because it is not a UI
change:

- The bot currently trades autonomously. A manual quote/simulate/swap path adds
  a **new way to spend real SOL** that has never existed in this system.
- It needs its own risk gating: does a manual order go through the same risk
  engine checks as an automated entry, or bypass them? Bypassing is how
  operators blow up accounts at 3am.
- `DRY_RUN` currently gates the whole engine. A manual execution route needs its
  own independent kill switch, not just the shared flag.

My recommendation: build it in two separate, separately-reviewed changes —
**(a)** quote + simulate only, read-only, no broadcast path in the code at all;
**(b)** the broadcast path, gated behind its own env flag, routed through the
risk engine, with mandatory typed confirmation in the UI.

Say the word and I will start with (a).

### Dead files needing manual deletion

I had no shell access to delete files. These are now unrouted and unimported,
and should be removed (they still compile, so they will not break the build):

```
src/pages/TerminalPage.tsx
src/pages/TokensPage.tsx
src/pages/HistoryPage.tsx
src/components/MayhemBotUi.tsx
src/components/MarketWatchlist.tsx
src/components/MarketChart.tsx
src/components/DashboardHeader.tsx
src/components/Sidebar.tsx
src/components/PortfolioSummary.tsx
src/components/PositionsPanel.tsx
src/components/OrderPanel.tsx
src/components/OrderHistory.tsx
src/components/ActivityFeed.tsx
src/components/StrategyMetrics.tsx
src/components/DebugPanel.tsx
src/components/SystemStatus.tsx
src/components/ApiStatus.tsx
src/components/BotControls.tsx
src/components/EmergencyStop.tsx
src/components/RejectionsPanel.tsx
src/styles/app.css
src/styles/terminal.css
src/styles/sidebar.css
src/styles/positions.css
src/styles/history.css
src/styles/config.css
src/styles/tokens.css
src/types/terminal.ts
src/hooks/useMarket.ts          (tombstone — safe to delete)
src/data/market.ts              (tombstone — safe to delete)
```

Keep: `ErrorBoundary.tsx`, everything under `components/ui/`,
`components/shell/`, `ConfirmDialog.tsx`, all hooks except `useMarket`.

### Known tech debt

- **Two API clients.** `src/lib/api.ts` (`apiFetch`) and `src/api/client.ts`
  (`api`) both exist and duplicate base-URL resolution and error handling. The
  new code uses `apiFetch`; `ConfigPage` still uses `api` because its
  `ApiError.details` handling is better. These should be consolidated onto one
  client that keeps the timeout and `details` support from `api/client.ts`.
- **No real-time transport.** Everything is polling (3–15s). The spec assumes
  WebSocket throughout. Panels state their polling interval rather than
  implying live streaming.
- **`MAYHEM_UI_SPEC.md` lives at the repo root**, not `docs/` as the directive
  states. Recommend moving it.
- Server-side pagination is absent; `/api/trades` is capped client-side at 200.
