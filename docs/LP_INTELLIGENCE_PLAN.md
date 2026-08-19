# Pre-LP + LP Reserve Intelligence — Inspection & Implementation Plan

Status: **Plan only. No implementation code written yet.**
Date: 2026-08-17

---

## 0. Two blocking constraints, stated first

**A. I cannot run the validation commands.** The sandbox Linux VM has failed to
start for this entire session. `pnpm typecheck`, `pnpm build` and `vitest`
cannot be executed by me. Your §20 says "do not declare completion until the
implementation passes the repository's validation commands" — I can write the
code, but you must run validation, and I will not claim completion.

**B. Three premises in the directive do not hold.** Details in §2 below:

1. There is **no MAYHEM scoring system** to integrate with (§8).
2. There is **no WebSocket infrastructure** in the API or dashboard (§16).
3. `LiquidityMonitor` — the component §4 would naturally extend — **is a
   non-functional stub**. This one is a live safety issue, see §1.

---

## 1. Critical finding: LiquidityMonitor does nothing

`packages/token-monitor/src/liquidity-monitor.ts`

```ts
constructor(_conn: unknown, opts = {}) { ... }   // connection ignored
start(): void { /* No-op for this lightweight monitor stub. */ }
stop():  void { /* No-op */ }
```

The only code path that can ever emit a `LiquidityAlert` is
`simulateLiquidityChange()`, which nothing in production calls. It holds a
`watchedPools` map that is written but never read against chain state.

**Consequence:** any belief that the bot detects liquidity being pulled from a
pool it holds a position in is unfounded. `liquidityDropExitPercent` is
accepted, stored, and never applied to real data. If a rug pull happens, the
exit that fires is the ordinary stop-loss or max-hold timer, not a liquidity
alert.

This is the single most important thing found during inspection and it is
worth confirming independently before anything else is built on top.

---

## 2. Where the directive's premises diverge from the repo

| Directive says | Reality |
|---|---|
| §8 "Integrate into the existing MAYHEM scoring system… do not rewrite it" | **No scoring system exists.** The only score is `heuristicRiskScore` in `apps/bot/src/enrichment.ts` — 15 lines, display-only, explicitly "not a real risk model", and scored **higher = safer**. There is nothing to integrate with; a MAYHEM Score would be built from scratch. |
| §16 "Use the existing WebSocket infrastructure" | **None exists.** `express-ws` is a dependency of `apps/api` but is never imported. The dashboard is 100% HTTP polling. Geyser WS is used bot-side for discovery only and does not reach the API. "LP events should update the UI without unnecessary polling" therefore requires building the transport first. |
| §4 "continuously monitor reserve changes" (extending existing monitor) | `LiquidityMonitor` is a stub (§1). This is new construction, not extension. |
| §12 "do not create duplicate tables if equivalent models already exist" | `pools` exists but stores **current state only** — no history. `pool_reserves`, `liquidity_events`, `lp_snapshots`, `token_lifecycle_events` do not exist. |

---

## 3. What genuinely exists and should be reused

### Strong reuse — build on these

| Asset | Location | Why it matters |
|---|---|---|
| `TokenDiscoveryEvent` | `token-monitor/src/types.ts` | Already carries ~70% of the §1 Pre-LP field list: `mintAuthority`, `freezeAuthority`, `decimals`, `supply`, `supplyRaw`, `creator`, `creatorSource`, `metadataUri`, `txSignature`, `detectedSlot`, `initializationSlot`, `observedViaWebsocket`, `poolVerificationStatus`, `baseVault`, `quoteVault`, `quoteReserveSol`, `lpMint`, `lpLockOrBurnVerified`. **Extend, do not replace.** |
| `RaydiumPoolVerifier` | `token-monitor/src/raydium-pool-verifier.ts` | Real AMM-v4 + CPMM decoding. Returns `baseVault`, `quoteVault`, `lpMint`, `quoteReserveSol`, `poolVerifiedAtMs`. This *is* the Phase 2 pool-detection primitive for Raydium. |
| `readBondingCurve` / `bondingCurvePda` | `packages/execution/src/pumpfun.ts` | pump.fun pre-graduation "pool". Exposes `realSolReserves`, `realTokenReserves`, `virtual*`, and a `complete` flag that is `undefined` when unreadable — already models OBSERVED vs UNKNOWN correctly. |
| `pools` table | `database/src/migrations/001_initial.sql:38` | `address`, `token_mint`, `quote_mint`, `liquidity`, `reserve_token`, `reserve_quote`, `status`, `last_updated`. Current-state row exists; history does not. |
| `RiskCheck[]` model | `risk-engine/src/types.ts` | `{name, passed, value, threshold, message}` — LP checks slot in as additional checks with no change to the engine's shape. Explainability is already the design. |
| `risk_events`, `bot_events` tables | migration 001 | Liquidity events can persist here rather than inventing a parallel event store. |
| `postInternalTokens` merge | `apps/api/src/routes.ts` | Partial-update merge semantics already correct for incremental LP enrichment. |
| `Unavailable` / `Value` / `NotWired` | `apps/dashboard/src/components/ui/States.tsx` | §17 data-integrity display is already built and enforced. |

### Notable gap

Bot → API sync carries **only** `/internal/tokens` and `/internal/telemetry`.
No positions, no pools, no reserves, no events. Every dashboard requirement in
§14/§15 needs a new internal ingest route plus an emitter in the bot.

---

## 4. Proposed architecture

New package: **`packages/lp-intelligence`** — keeps the state machine, reserve
capture and health assessment out of `token-monitor` (which is discovery) and
out of `risk-engine` (which is decisions). Depends on `@mayhem/solana`,
`@mayhem/execution`, `@mayhem/core-types`.

```
                    ┌─ RaydiumPoolVerifier (existing)
 discovery ─────────┤
                    └─ readBondingCurve   (existing)
                              │
                              ▼
                   PoolAdapter (new, per-DEX)  ──► NormalizedPool
                              │
                              ▼
                   LifecycleStateMachine (new)  ──► TokenLifecycleState
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
            ReserveSnapshot  LpHealth  LiquidityEvent
                    │         │         │
                    └────┬────┴────┬────┘
                         ▼         ▼
                 EntryEligibility  persistence ──► API ──► dashboard
                         │
                         ▼
                    risk-engine (existing RiskCheck[])
```

### Lifecycle states (subset of §1 — only observable ones)

`PRE_LP` → `LP_DETECTED` → `LP_INITIALIZED` → `LIQUIDITY_VALIDATING` →
`TRADEABLE` → `LIQUIDITY_DEGRADED` / `LIQUIDITY_REMOVED` → `CLOSED`

Transitions are driven only by observed conditions. Every state carries the
`slot`, `txSignature` and `observedAt` that justified it. **A pool account
existing yields `LP_DETECTED`, never `TRADEABLE`** — per §1's explicit warning.

### Provenance type — the mechanism enforcing §17

```ts
type Provenance = 'OBSERVED_ONCHAIN' | 'ESTIMATED' | 'UNAVAILABLE';

interface Observed<T> {
  value: T | null;          // null iff provenance === 'UNAVAILABLE'
  provenance: Provenance;
  slot: number | null;
  txSignature: string | null;
  observedAt: string;
  source: string;           // e.g. 'raydium-amm-v4-vault-read'
}
```

Every reserve, liquidity and price-impact figure is an `Observed<number>`.
An `ESTIMATED` value can never be assigned into a field typed as observed —
the type system, not developer discipline, prevents the substitution §3
forbids. The dashboard already renders `null` as `N/A` via `Value`.

---

## 5. Phasing

Each phase leaves the repo building and is independently reviewable. Estimates
assume you run validation between phases.

| Phase | Scope | New/changed files | Risk |
|---|---|---|---|
| **1** | `packages/lp-intelligence` skeleton: `Observed<T>`, `NormalizedPool`, `LiquidityEvent`, `LpHealth`, `EntryEligibility`, lifecycle state machine + unit tests. **Pure types and logic, zero I/O.** | ~8 new | None — nothing wired in |
| **2** | `PoolAdapter` interface + Raydium adapter (wraps existing verifier) + pump.fun adapter (wraps `readBondingCurve`). Normalizes both into `NormalizedPool`. | ~4 new | Low |
| **3** | Initial reserve snapshot on `LP_INITIALIZED`, with slot + signature. Provenance enforced. | ~2 new, 1 changed | Low |
| **4** | **Replace the `LiquidityMonitor` stub** with a real poller over pool vaults / curve accounts. Emits `LiquidityEvent`. Rate-limit aware (reuses the `withRetry` pattern from `enrichment.ts`). | 1 rewritten, ~3 new | **Medium — new sustained RPC load** |
| **5** | Migration `002_lp_intelligence.sql`: `pool_reserves`, `liquidity_events`, `token_lifecycle_events`. Repositories. | ~4 | Low |
| **6** | LP `RiskCheck`s + `EntryEligibility` with reason codes, consumed by the execution path. | ~3 changed | **High — gates entries** |
| **7** | Bot→API ingest (`/internal/pools`, `/internal/lp-events`) + read routes (`/api/tokens/:mint/lifecycle`, `/liquidity`, `/lp-events`, `/entry-eligibility`). | ~6 | Low |
| **8** | Dashboard: Pre-LP view, Discover LP columns, Intelligence LP section, lifecycle timeline, execution gating display. | ~8 | Low |
| **9** | Config: extend `packages/config/src/schema.ts` using existing `envBool`/`envSol`/`envPct` helpers + `.env.example` + docs. | ~3 changed | Low |
| **10** | Integration tests, fixtures, reconciliation. | ~6 | — |

Phases 1–3 are safe and self-contained. **Phase 6 changes what the bot is
allowed to trade** and should be reviewed on its own, in dry run, before
anything else.

---

## 6. Configuration — following existing conventions

`packages/config/src/schema.ts` uses `envBool(default)`, `envSol(default)`,
`envPct(default)`, `envNum(default)`, and `envXOptional()` for alias primaries.
Proposed additions in that style, in a new `── LP INTELLIGENCE ──` block:

```
PRE_LP_MONITOR_ENABLED          envBool(false)   # observational, opt-in
LP_MONITOR_ENABLED              envBool(false)
LP_POLL_INTERVAL_MS             envNum(5_000)
LP_MAX_POOLS_TRACKED            envNum(50)       # bounds RPC load
MIN_INITIAL_LIQUIDITY_SOL       envSol(0)        # 0 = no floor, matches profile
MIN_TRADEABLE_LIQUIDITY_SOL     envSol(0)
MAX_LIQUIDITY_DROP_PCT          envPct(40)       # matches existing default
LIQUIDITY_DROP_WINDOW_SECONDS   envNum(60)
MAX_PRICE_IMPACT_PCT            envPct(3)
MIN_POOL_AGE_SECONDS            envNum(0)
REQUIRE_INITIAL_RESERVE_SNAPSHOT envBool(true)
BLOCK_UNVALIDATED_POOLS         envBool(true)
LP_EVENT_ALERT_ENABLED          envBool(true)
LP_WITHDRAWAL_ALERT_ENABLED     envBool(true)
```

Two deliberate choices:

- **Both monitors default to `false`.** §18 says Pre-LP monitoring is
  observational by default; a feature that adds sustained RPC load should not
  switch itself on during an upgrade.
- **No `.default()` on any key that participates in a `??` alias chain** —
  that is finding F1 in `docs/audits/CONFIG_AUDIT.md`, the bug that made the
  bot trade 0.5 SOL while its config said 0.05.

---

## 7. Cost and load — the thing most likely to bite

Phase 4 is a continuous poller. Current RPC budget is already tight:
`MAX_DISCOVERIES_PER_MINUTE=5`, enrichment retries on 429, and `enrichment.ts`
explicitly skips Raydium work to avoid worsening rate limiting.

Tracking N pools at interval I costs `2N/I` account reads per second (base +
quote vault), plus curve reads for pump.fun. At N=50, I=5s that is 20 reads/s
sustained — comparable to the entire existing discovery pipeline.

Mitigations built into the design: `LP_MAX_POOLS_TRACKED` ceiling; priority to
pools with open positions; `getMultipleAccounts` batching; adaptive backoff on
429; stop tracking on `CLOSED`. Even so, expect this to roughly double RPC
usage when enabled, and it is the reason both flags default off.

---

## 8. What will remain UNKNOWN, by design

Per §17, these have no reliable on-chain source and will render `N/A`:

- **LP lock / burn status** — requires per-DEX LP-mint supply and lock-program
  inspection. `lpLockOrBurnVerified` already exists as `boolean | null`; it
  stays `null` unless genuinely verified. §5 explicitly forbids claiming a lock
  without evidence.
- **Holder count** — needs `getProgramAccounts` or a DAS provider.
- **24h volume** — no trade-history store.
- **Wallet labels / smart-money** — no data source at all.
- **USD liquidity** — needs a SOL/USD price feed the repo does not have. SOL
  liquidity will be reported; USD stays `UNAVAILABLE` rather than estimated.
- **Historical reserves before first observation** — §3 forbids reconstruction.
  Pools discovered mid-life will have no initial snapshot and must be marked
  `REQUIRE_INITIAL_RESERVE_SNAPSHOT`-failing rather than back-filled.

---

## 9. Recommendation

Do **not** attempt all ten phases in one pass. Concretely, I suggest:

1. **Confirm the §1 finding independently.** If `LiquidityMonitor` really is
   inert, that is a live gap in rug protection today and outranks new features.
2. **I implement Phases 1–3** (types, state machine, pool adapters, initial
   reserve capture, unit tests). Pure logic, no I/O, no trading impact,
   reviewable in one sitting.
3. You run `pnpm typecheck && pnpm build && pnpm test`.
4. Then decide on Phase 4 (RPC cost) and Phase 6 (entry gating) separately —
   those are operational risk decisions, not implementation details.

Say which phases to start and I will begin.
