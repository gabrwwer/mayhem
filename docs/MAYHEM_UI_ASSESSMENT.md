# MAYHEM UI — Repository Assessment (Stage 0)

Status: Assessment only. No code changed.
Date: 2026-08-17
Scope: `apps/dashboard`, `apps/api`, `packages/*` as they relate to the UI spec.

---

## 1. Spec location correction

The directive references `docs/MAYHEM_UI_SPEC.md`. The file actually lives at
the repository root: `MAYHEM_UI_SPEC.md`. No copy exists under `docs/`.
Recommend moving it to `docs/` (or updating the directive) so there is one path.

---

## 2. What actually exists

### 2.1 Dashboard (`apps/dashboard`, package `optik-mayhem-terminal`)

Vite + React 18, plain TypeScript, hand-written CSS. Dependencies are
**React and React-DOM only**.

| Concern | Present? | Notes |
|---|---|---|
| Router | ✗ | Navigation is `useState<PageType>` in `App.tsx` |
| State management | ✗ | Local hooks + polling only |
| Charting library | ✗ | `MarketChart.tsx` is hand-rolled |
| CSS framework / design tokens | ✗ | 6 ad-hoc CSS files, hardcoded hex, no `:root` variable system |
| Data-fetch layer | ✓ | `src/api/client.ts` — timeouts, `ApiError`, bearer auth. Good. |
| Response normalizers | ✓ | `src/types/api.ts` — defensive `normalize*` functions. Reusable as-is. |
| Error boundary | ✓ | `ErrorBoundary.tsx` |

Existing pages: `TerminalPage`, `TokensPage`, `PositionsPage`, `HistoryPage`,
`ConfigPage`. That is 5 of the 13 sections the directive asks for.

Existing components worth keeping: `ErrorBoundary`, `EmergencyStop`,
`BotControls`, `ApiStatus`, `SystemStatus`, `RejectionsPanel`, `DebugPanel`,
`StrategyMetrics`, `PositionsPanel`, `ActivityFeed`.

### 2.2 API (`apps/api`)

Express, single wired app in `src/index.ts`. Security posture is deliberate and
good: mandatory bearer auth on every `/api/*` route (including reads), rate
limiting, HMAC-signed `/internal/*` ingest, loopback bind by default, refuses to
boot without credentials. `src/app.ts` is an intentional tombstone — do not
resurrect it.

Endpoints available today:

```
GET  /health                     (unauthenticated, liveness only)
GET  /api/status                 status, dryRun, tradingEnabled, emergencyStop,
                                 startedAt, openPositions, totalTrades
GET  /api/tokens                 discovered tokens (bot-pushed, merged)
GET  /api/launches               last 100 launches
GET  /api/positions              ?status=open|closed|all
GET  /api/trades                 ?limit=
GET  /api/balance                { sol, tokens } — live RPC when DRY_RUN=false
GET  /api/config                 14 whitelisted numeric fields + flags
GET  /api/telemetry              pnl, win/loss, latency averages
GET  /api/rejections             last 200 filter rejections
POST /api/start | /api/pause | /api/emergency-stop
POST /api/positions/:id/close
POST /api/config                 (409 unless DRY_RUN)
POST /api/tokens/clear
POST /internal/tokens | /internal/telemetry   (HMAC, bot -> API)
```

Note: `/api/launches` is served but **the dashboard client never calls it**.

### 2.3 Backing packages

`analytics`, `risk-engine`, `market-data`, `token-monitor`, `execution`,
`ledger`, `accounting`, `database`, `solana`, `trading-engine`, `core-types`.
These exist and are candidates for backing new endpoints, but none of them are
currently exposed through the API surface above.

---

## 3. What is broken or violates the directive

### 3.1 Fabricated data in the shipping UI — **highest priority**

Two hardcoded fake datasets feed live-looking panels with no DEMO/MOCK label:

- `src/hooks/useMarket.ts` — 5 invented tokens (MAYHEM, ANARCHY, QUANT, VOID,
  ROCKET) with invented prices, liquidity, holders, risk scores.
- `src/data/market.ts` — a second, near-duplicate invented token list.

These are consumed by `MarketWatchlist` / `MarketChart` / `TerminalPage`. This
directly violates the directive's Data Integrity Rule. Must be removed or moved
behind an explicit DEMO mode flag before anything else is built on top.

### 3.2 Duplicate type definitions

`types/api.ts`, `types/trading.ts`, and `types/terminal.ts` each define an
overlapping token shape (`ApiToken`, `MarketToken` ×2). One canonical set is
needed.

### 3.3 No real-time transport

The spec assumes WebSocket-fed live updates throughout ("Updated via
WebSocket", "streaming feed"). There is **no WebSocket anywhere** in `apps/api`
or `apps/dashboard`. Everything is interval polling (3s status, 5s positions).
Either a WS/SSE channel is added to the API, or the UI must honestly present
itself as polled at N-second intervals.

### 3.4 `main.tsx` does not appear to mount `ErrorBoundary` around routes

To be confirmed during implementation; currently only a component exists.

---

## 4. Spec sections vs. backend reality

Legend: ✅ backend supports it · ⚠️ partial · ❌ no backend data source

| Spec section | Backend status | Gap |
|---|---|---|
| Global header — DRY RUN/LIVE, engine status, emergency stop | ✅ | `/api/status` covers all of it |
| Header — RPC status, WS status, latency | ❌ | No endpoint. Only client-measured HTTP round-trip exists. |
| Header — wallet connection | ⚠️ | `/api/balance` implies a wallet; no address/connection-state endpoint |
| Dashboard — portfolio value, realized/unrealized/daily P&L, exposure | ⚠️ | `/api/telemetry` has `totalPnl` only. No daily bucket, no exposure, no risk utilisation. |
| Dashboard — open positions with stop/TP/age | ⚠️ | Positions lack `stopLoss`, `takeProfit`, `trailingStop` fields |
| Discover / scanner | ⚠️ | `/api/tokens` has price, liquidity, marketCap, volume24h, holders, topHolderPercent, riskScore — all nullable and only when the bot enriched them. **No** volume surge, holder growth, DEX, 1m/5m/1h volume buckets, token age. |
| MAYHEM Score (0–100, six components) | ❌ | Does not exist. Only `riskScore` (different, inverted semantics). Needs a backend scoring service or must be shown as unavailable. |
| Smart-money / wallet accumulation flags | ❌ | No data source at all |
| Markets | ❌ | No endpoint |
| Token Intelligence (chart, holders top-50, tx feed, authorities, pools) | ❌ | No OHLC, no holder distribution, no tx stream, no authority endpoint |
| Positions table | ⚠️ | Core fields yes; stop/TP/trailing/score no |
| Position actions: close | ✅ | `POST /api/positions/:id/close` |
| Position actions: modify, partial close | ❌ | No endpoint |
| Trades | ✅ | `/api/trades` |
| Portfolio | ⚠️ | `/api/balance` + `/api/telemetry`; no equity curve endpoint (data exists in Postgres `equity_snapshots` but is not exposed) |
| Execution panel (quote, route, price impact, simulate, execute) | ❌ | No quote/simulate/swap endpoints. Bot executes autonomously; there is no manual-order API. |
| Risk Center | ⚠️ | Limits readable from `/api/config`; **current values** (exposure %, daily drawdown, largest position) are not exposed |
| Alerts | ❌ | No alerts endpoint. `/api/rejections` is the nearest thing. |
| Activity log | ⚠️ | Client-side ring buffer in `useActivity` only — not server events, not persisted, lost on refresh |
| System Health | ⚠️ | `/api/telemetry` gives latency averages; no per-component status, heartbeat, reconnect counts, or queue depth |
| Config | ⚠️ | 14 numeric fields only. Spec asks for RPC/WS/monitoring/safety config — not in `CONFIG_FIELDS`. |
| Settings | ❌ | No endpoint (may be client-local only) |

**Summary: roughly 30% of the spec has a real backend today.**

---

## 5. Recommended sequencing

**Stage 1 — Foundation (UI only, no backend work)**
1. Design-token layer: `:root` CSS variables (near-black surfaces, electric
   blue primary, cyan secondary, green/red/amber status), density scale,
   typography. Replace hardcoded hex.
2. App shell: persistent sidebar (13 sections), persistent status bar, state
   preserved across section changes. Add `react-router-dom` for real routes +
   deep linking, or keep the state machine — decision needed.
3. Unmistakable DRY RUN vs LIVE treatment in the header.
4. Delete `useMarket.ts` / `data/market.ts` fake data, or gate behind
   `VITE_DEMO_MODE` with a persistent on-screen DEMO banner.
5. Canonical `Unavailable` / `NoData` / `Loading` / `Error` primitives so every
   missing metric renders `N/A` with a tooltip naming the missing endpoint.

**Stage 2 — Wire what already exists**
Dashboard, Discover, Positions, Trades, Config, Activity, System (partial) —
all against current endpoints, with honest N/A everywhere else.

**Stage 3 — Backend additions (each is a separate, reviewable change)**
In value order:
1. `GET /api/risk` — current exposure, daily P&L, drawdown, consecutive losses
   vs. configured limits, with allowed/warned/blocked verdicts. Highest value,
   lowest risk, data already in `BotState` + `risk-engine`.
2. `GET /api/health/components` — per-engine status, latency, heartbeat,
   reconnects, queue depth.
3. `GET /api/events` (or SSE `/api/events/stream`) — server-side persisted
   activity log replacing the client ring buffer.
4. `GET /api/portfolio/equity` — equity curve from `equity_snapshots`.
5. WebSocket or SSE push channel to replace polling.
6. MAYHEM Score service — genuinely new work; needs its own design.

**Explicitly out of scope until you say otherwise:** manual buy/sell execution
API, quote/simulate endpoints, holder distribution, transaction feed,
smart-money detection. These are new trading surfaces on a bot that currently
trades autonomously, and adding a manual order path is a risk decision, not a
UI decision.

---

## 6. Open decisions needed before Stage 1

1. **Router** — add `react-router-dom` (deep links, back button, 13 routes) or
   keep the zero-dependency `useState` switch?
2. **Charts** — add a library (`lightweight-charts` / `recharts`) or extend the
   hand-rolled SVG chart? Nothing renders candlesticks today.
3. **Backend work** — am I authorised to add the read-only endpoints in Stage 3,
   or is this engagement UI-only against the existing API?
4. **Demo mode** — delete the fake token data outright, or keep it behind an
   explicit `VITE_DEMO_MODE` flag with a persistent banner?
5. **Manual execution** — the spec's execution panel implies manual order
   placement, which does not exist. Confirm: render it read-only/disabled with
   a documented gap, rather than building an order path.

---

## 7. Hard constraints observed

- `apps/bot/.env` and `apps/api` credentials are never to be rendered. The
  config page must continue to expose only the 14 whitelisted numeric fields;
  any new config surface needs a matching server-side whitelist.
- `POST /api/config` correctly 409s unless `DRY_RUN` — the UI must not imply
  otherwise.
- Emergency stop is a one-way latch (`/api/start` refuses while it is set).
  The UI must show how to clear it, or state that it requires a restart.
- `apps/api/src/app.ts` stays removed.
