# Runtime Configuration vs STRATEGY.md — Reconciliation

Date: 2026-08-17
Authority: `docs/development/STRATEGY.md` is the source of truth.
Status of the strategy itself: **UNVALIDATED HYPOTHESIS — NOT CLEARED FOR LIVE
CAPITAL. Stage 0 (Measurement).**

No profitability claim is made anywhere in this document. No backtest or live
results are cited, because none exist (STRATEGY.md §0).

---

## 0. Correction to earlier advice

Earlier in this engagement I recommended `STOP_LOSS_PCT=40` and
`MAX_HOLD_SECONDS=600`, sourced from the strategy profile in the project
instructions. **That was wrong.** STRATEGY.md §6 specifies `STOP_LOSS_PCT=15`
and `MAX_HOLD_SECONDS=120`. Acting on my earlier figure would have widened the
stop to more than twice the specified value.

The project-instruction profile and STRATEGY.md disagree on at least three
values. Per this task's directive, STRATEGY.md wins. The project profile
should be corrected or removed so the next reader does not hit the same
conflict.

| Parameter | Project profile | STRATEGY.md §6 | Authoritative |
|---|---|---|---|
| Stop loss | 40% | **15%** | 15% |
| Max hold | 600 s | **120 s** | 120 s |
| Trailing stop | 25% | 25% | agree |
| Sell ladder | 30@2x,30@3x,40@5x | same | agree |

---

## 1. Exit parameters — current vs specified

| Key | Live `.env` | STRATEGY.md §6 | Verdict |
|---|---|---|---|
| `STOP_LOSS_PCT` | 8 | 15 `[PROVISIONAL]` | **DIVERGENT** |
| `TRAILING_STOP_PCT` | 25 | 25 | OK |
| `MAX_HOLD_SECONDS` | 120 | 120 `[PROVISIONAL]` | OK |
| `SELL_LADDER` | *unset* (schema default `30@2x,30@3x,40@5x`) | `30@2x,30@3x,40@5x` | OK by default only |
| `TAKE_PROFIT_PERCENT` | **3** | not in the exit table | **CONFLICT** |

### The `TAKE_PROFIT_PERCENT=3` conflict

STRATEGY.md §6 addresses this directly and unusually bluntly:

> `TAKE_PROFIT_PERCENT=3` combined with a 0.05 SOL position is likely
> unprofitable *by construction*, independent of signal quality.

Round-trip cost — priority fees, Jito tip, two-sided slippage at
`SLIPPAGE_BPS=25` — can exceed a 3% gross target on a 0.05 SOL position. This
is the mechanism behind the "opened and closed immediately" behaviour observed
in testing: the position was inside a +3% / −8% band and a bonding-curve token
crosses 3% within one or two 3-second monitor ticks.

Two profit-taking mechanisms currently exist in configuration. The directive is
explicit that they must not coexist. Which one the engine actually honours has
**not been determined** — see §4 below.

---

## 2. Entry parameters — current vs specified

| Metric | Live `.env` | STRATEGY.md §3.4 | Verdict |
|---|---|---|---|
| `MIN_BUY_PRESSURE` | 0.65 | ≥ 0.65 | OK |
| `MIN_MOMENTUM_CHANGE_PCT` (netFlow) | 2 | ≥ +0.02 (2%) | OK |
| `MAX_MOMENTUM_VOLATILITY` | 0.5 | ≤ 0.50 | OK |
| `MAX_MOMENTUM_DRAWDOWN_PCT` | 10 | ≤ 0.10 (10%) | OK |
| `MIN_MOMENTUM_SAMPLES` | 10 | ≥ 10 | OK |
| `MOMENTUM_CONFIRM_INTERVAL_MS` | 5000 | **2000** | **DIVERGENT** |
| `MOMENTUM_CONFIRM_DURATION_MS` | 60000 | 60000 | OK |

### Sample-budget defect

The interval divergence is not cosmetic. At the specified 2 s interval a 60 s
window yields **30 samples** against a minimum of 10 — 20 spare. At the live
5 s interval it yields **12**, leaving 2 spare. Two failed RPC reads inside the
window and the candidate is rejected for insufficient samples regardless of
what the price did.

Correcting the interval to the specified 2000 ms is therefore the single
highest-value change in this document, and it is a **restoration of spec**, not
a loosening of a threshold. It does not alter any entry criterion.

**Important:** I earlier suggested lowering `MIN_MOMENTUM_SAMPLES` to 6 and
raising `MAX_MOMENTUM_DRAWDOWN_PCT` to 25. Both would have moved the config
*away* from spec. Withdrawn. The thresholds are correct as configured; the
sampling rate is what is wrong.

---

## 3. Sizing and safety — current vs specified

| Key | Live `.env` | STRATEGY.md §5 | Verdict |
|---|---|---|---|
| `SNIPE_POSITION_SOL` | 0.5 | 0.05 | **DIVERGENT (10×)** — but see below |
| `MAX_POSITION_SOL` | 0.05 | 0.05 | OK |
| `MAX_CONCURRENT_POSITIONS` | *unset* | 3 | unset |
| `MAX_OPEN_POSITIONS` | 2 | — | alias, see §4 |

`SNIPE_POSITION_SOL=0.5` is currently inert: `schema.ts:332` resolves
`positionSol = MAX_POSITION_SOL ?? SNIPE_POSITION_SOL ?? 0.5`, so the 0.05
wins. It is nonetheless a live hazard — should `MAX_POSITION_SOL` ever be
unset, sizing silently becomes 10× spec. It should be corrected to 0.05
regardless of which key currently dominates.

---

## 4. Open questions requiring code inspection before any change

These are **not** answered yet and must be before the corresponding change is
made:

1. **Does the engine honour `SELL_LADDER` or `TAKE_PROFIT_PERCENT`, or both?**
   `packages/trading-engine/src/engine.ts` and `position-manager.ts` have not
   been read. Deleting the wrong key could remove the only working profit exit.
2. **Ladder semantics.** Whether `30@3x` means 30% of the *original* position
   or 30% of the *remainder* materially changes the exit curve. Must be read
   from the implementation, not assumed.
3. **Exit priority order as implemented.** STRATEGY.md §6 places stale-price
   and stop-loss jointly at priority 1. Whether the engine evaluates in that
   order is unverified.
4. **`MAX_OPEN_POSITIONS` vs `MAX_CONCURRENT_POSITIONS`.** Two keys, one
   concept, an alias-resolution pattern that has already produced one
   production defect (schema.ts F1). Which the engine reads is unconfirmed.

---

## 5. Configuration integrity defect (STRATEGY.md §8.2)

Confirmed present. `apps/bot/src/index.ts` reads safety-critical values through
ad-hoc `envNumber()` calls that bypass `FlatEnvSchema`:

```ts
const maxPositionSol = envNumber('MAX_POSITION_SOL', ...);
```

`MAX_POSITION_SOL` is not in `ENV_KEYS`, so it receives no bounds check, no
type validation, and takes no part in the `superRefine` cross-field invariants
— including the one proving the circuit breaker trips before the stop-loss
alone could exhaust the day's capital.

**The schema proves its invariants about values the bot does not use.**
`MAX_POSITION_SOL=100` would be accepted silently.

Confirmed additional direct reads in `apps/bot/src/index.ts` include
`SIM_INITIAL_SOL`, `MIN_HOLDERS`, `SLIPPAGE_BPS`, `MONITOR_INTERVAL_MS`,
`MAX_PRICE_AGE_MS`, `MAX_DISCOVERIES_PER_MINUTE`, `INTERNAL_API_SECRET`. A
full audit of `packages/trading-engine`, `packages/risk-engine` and
`packages/execution` has **not** been done.

This is the highest-severity item in this document. It is also the largest:
moving every tunable into the schema changes the boot path of a system that
trades, and it must not be attempted without a working test suite.

---

## 6. Immediate `.env` corrections

These restore spec and require no code change. Apply one at a time per
`config-tune`; each change restarts any Stage 0 measurement sample in progress
(STRATEGY.md §7.2).

```
STOP_LOSS_PCT=8                 →  15
MOMENTUM_CONFIRM_INTERVAL_MS=5000  →  2000
SNIPE_POSITION_SOL=0.5          →  0.05
MAX_CONCURRENT_POSITIONS        →  3        (currently unset)
```

`TAKE_PROFIT_PERCENT=3` is deliberately **not** listed. Removing or changing it
requires resolving question 1 in §4 first; doing so blind risks deleting the
only functioning profit exit.

---

## 7. Staged implementation plan

| Stage | Scope | Risk | Blocked on |
|---|---|---|---|
| A | `.env` corrections in §6 | Low | nothing |
| B | Read `engine.ts` / `position-manager.ts`; answer §4 questions; document ladder semantics | None (read-only) | nothing |
| C | Resolve the ladder / take-profit conflict in code | **High — changes exit behaviour** | B, working test suite |
| D | Entry signal from `readBondingCurve()` per §3.3 | High | B, working test suite |
| E | Config integrity refactor (§5) | **Highest — changes boot path** | working test suite |
| F | Test suite per directive §13 | — | must precede C, D, E |

**F must come before C, D and E.** The directive's §14 forbids deleting safety
checks to make tests pass; the corollary is that safety-critical changes must
not be made where tests cannot be run at all.

---

## 8. Validation status of this document

`pnpm typecheck`, `pnpm test` and `pnpm exec tsc --build` **were not run.** The
sandboxed Linux environment failed to start for the entire session. Every
finding here is from static reading of the repository.

Nothing in this document is marked IMPLEMENTED. Per the directive's §15, that
label requires code and tests that actually verify the behaviour.

| Directive item | Status |
|---|---|
| 1. Exit parameters | **NOT IMPLEMENTED** — divergences identified, §4 unresolved |
| 2. Exit priority | **NOT IMPLEMENTED** — order as-implemented unverified |
| 3. No averaging down | **NOT VERIFIED** — no buyback found, but not audited |
| 4. Entry strategy | **NOT IMPLEMENTED** |
| 5. Observation parameters | **PARTIALLY** — divergence found, not corrected |
| 6. Position sizing | **PARTIALLY** — divergence found, not corrected |
| 7. Stage 0 safety | **UPHELD** — no profitability or validation claimed |
| 8. Paper-trading gate | **NOT APPLICABLE** at Stage 0 |
| 9. Configuration integrity | **NOT IMPLEMENTED** — defect confirmed, scoped |
| 10. Authentication | **PRESERVED** — untouched |
| 11. Helius / RPC separation | **PRESERVED** — untouched |
