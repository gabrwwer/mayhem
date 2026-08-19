# Exit Slippage Hardening Spec

**Status:** Proposed — not implemented
**Date:** 2026-08-14
**Scope:** entry sizing, take-profit gate, dry-run config integrity
**Trigger:** 21-trade dry-run showing realized exits far outside configured thresholds

---

## 1. Observation

Three dry-run configurations, `sl=8` and `tp=3` in all three:

| config size (SOL) | trades | avg win | avg loss | max DD (SOL) |
|---|---|---|---|---|
| 0.05 | 2 | +5.73% | **-0.52%** | 0.000259 |
| 0.1 (filters undefined) | 4 | — | **-13.31%** | 0.053223 |
| 0.5 | 15 | +16.49% | **-23.29%** | 0.420322 |

Two facts require explanation:

1. Average loss is 1.7–2.9x the configured 8% stop, and **scales monotonically with position size**.
2. Average win is +16.49% against a configured 3% take-profit.

Neither is explained by a defect in stop evaluation. `PositionManager.checkStopLoss`
and `checkTakeProfit` (`packages/trading-engine/src/position-manager.ts:510-534`)
compare correctly against `actualEntryPrice`-derived levels, and the lock ladder
is monotonic. The exit path has already been hardened for staleness, partial
fills, duplicate exits, and concurrent pricing.

The causes are structural, not logical.

---

## 2. Root cause A — take-profit is unreachable at `tp=3`

`packages/trading-engine/src/engine.ts:554-577`:

```ts
// TP gate: require NET executable P&L to meet threshold
if (reason === 'take_profit') {
  if (netPnl.netPnlPercent < this.config.takeProfitPercent) {
    // ... log SKIP_TP_NOT_MET_NET, defer, release
    return null;
  }
}
```

The price trigger fires at `entry x 1.03`. The gate then requires **net** P&L —
after entry fees, exit fees, and sell price impact — to also clear 3%. On the
tokens being traded, round-trip cost exceeds 3%, so the gate never passes. The
position is deferred by `takeProfitRetryDelayMs` and re-deferred on every
subsequent trigger.

The position therefore rides until the **lock ladder** takes over. The ladder's
first rung activates at **+15%** (`position-manager.ts:14-22`).

Observed avg win of **+16.49%** sits directly on that first rung.

**Consequence:** `tp=3` has never executed. The strategy actually under test is
"ladder-from-+15% with an 8% stop", not the configured parameter set. Every
comparison across these three configs is measuring something other than what the
config says.

This is a correctness-of-experiment failure, not a loss-generating bug. The gate
itself is behaving as designed and should be kept.

---

## 3. Root cause B — entry-time liquidity cap does not bound exit impact

Sizing is capped at entry (`engine.ts:93-98`):

```ts
const participationCap =
  liquidity > 0
    ? liquidity * (this.config.maxLiquidityParticipationBps / 10_000)
    : this.config.maxPositionSol;

const amount = Math.min(this.config.maxPositionSol, participationCap);
```

`MAX_LIQUIDITY_PARTICIPATION_BPS` defaults to 100 (1%). This is correct as far
as it goes. Three gaps:

### B1 — Missing-liquidity fallback is unbounded

When `liquidity <= 0` — unavailable, unparsed, or not yet indexed — the cap
falls back to `maxPositionSol`, i.e. **full configured size with no constraint
at all**. The failure mode of "we could not measure the pool" is "trade it at
full size."

The 0.1 SOL config in the sample ran with `bp=undefined vol=undefined
dd=undefined n=undefined`, confirming that filter/metric plumbing was returning
undefined on that run. Liquidity was plausibly among the missing values. That
config went 0/4 with -13.31% average loss.

### B2 — Entry liquidity is not exit liquidity

The cap is computed once, at entry, from the pool as observed then. Average hold
is 34–96 seconds. On newly launched tokens, pool depth can fall substantially
within that window. A position sized to 1% of entry liquidity can represent a
far larger fraction of the pool by the time the stop fires — which is precisely
when everyone else is also selling.

`entryLiquidity` is stored on the position (`position-manager.ts:149`) but is
never re-read to re-evaluate exit feasibility.

### B3 — Stop distance is not validated against modeled exit impact

An 8% stop is only a stop if the position can be exited within 8%. Nothing
checks, before entry, whether a sell of `amount` into the observed pool would
clear less than 8% of impact. The engine computes `priceImpactPct` on the sell
quote at exit time (`engine.ts:509`, `:800`) and gates on
`maxSellPriceImpactPercent` — but by then the capital is already committed and
the only choices are "sell into the impact" or "hold a position with no working
stop."

The monotonic size/loss relationship in Section 1 is the signature of this gap.

---

## 4. Proposed changes

Ordered by expected effect. Each is independently shippable and independently
revertible.

### C1 — Fail closed on unknown liquidity

**File:** `packages/trading-engine/src/engine.ts` (~line 93)

Replace the unbounded fallback. When `liquidity <= 0` or non-finite, skip the
signal rather than defaulting to `maxPositionSol`.

```ts
if (!Number.isFinite(liquidity) || liquidity <= 0) {
  this.logger.info('SIGNAL_SKIPPED', { tokenMint, reason: 'liquidity_unknown' });
  return null;
}
const participationCap = liquidity * (this.config.maxLiquidityParticipationBps / 10_000);
const amount = Math.min(this.config.maxPositionSol, participationCap);
```

**Impact on entries:** strictly fewer entries; tokens with unresolved liquidity
are dropped.
**Impact on exits:** none.
**Impact on sizing:** removes the only path to uncapped size.
**Failure mode introduced:** if the liquidity source degrades, entry rate goes
to zero. This is the correct direction of failure, but it must be alerted on —
add a counter for `liquidity_unknown` skips and surface it, so a silent feed
outage is not mistaken for an absence of opportunities.

### C2 — Pre-trade exit-impact feasibility check

**File:** `packages/trading-engine/src/engine.ts`, in signal generation

Before committing, model the round-trip: estimate the price impact of selling
`amount` into `liquidity`, and require

```
estimatedExitImpactPercent + feesPercent < stopLossPercent x exitFeasibilityMargin
```

with `exitFeasibilityMargin` new config, suggested initial value `0.5` (exit
cost must consume less than half the stop distance). Reject the signal
otherwise.

The estimator should reuse whatever curve the sell-quote path already assumes
rather than introducing a second, divergent impact model. If the quote provider
can be asked for a hypothetical sell quote at entry time, prefer that over a
local approximation.

**Impact on entries:** fewer, concentrated in deeper pools.
**Impact on exits:** stop distance becomes executable, which is the point.
**Impact on sizing:** effectively couples max size to stop width.
**Failure mode introduced:** an over-optimistic impact model reintroduces the
current behaviour silently. Log modeled-vs-realized exit impact on every close
so the model is continuously falsifiable.

### C3 — Reject configs whose take-profit is below round-trip cost

**File:** config construction, `apps/bot/src/index.ts` (~line 260-280)

At startup, assert `takeProfitPercent` exceeds a floor derived from expected
round-trip cost. Fail loudly rather than degrading to ladder-only behaviour.

This does not change trading logic. It prevents future runs from silently
testing a parameter that cannot execute.

### C4 — Quarantine trades with an incomplete config snapshot

> **Revised after investigation. The original version of this item was wrong.**
>
> It proposed startup validation of `TradingConfig`, on the assumption that the
> `bp/vol/dd/n/win = undefined` run had executed with unset filters. That is not
> what happened:
>
> - `envNumber` (`apps/bot/src/index.ts:71-76`) falls back to its default on
>   both missing and unparseable input, and returns `Number.isFinite` values
>   only. Runtime config **cannot** contain undefined for these fields.
> - In `apps/bot/data/trades.jsonl`, `minBuyPressure` is present on lines
>   **5-25** and absent on lines **1-4**. Those first four records are exactly
>   the `maxPositionSol: 0.1` group that reported `undefined` and went 0/4.
>
> The four records were written by an **older build**, before the momentum
> fields were added to the journal schema. The filters were probably active;
> the journal simply did not record them. Startup validation would not have
> prevented this and would guard a failure that cannot occur.
>
> The defect is at the **reporting** boundary, not the config boundary.

**File:** `scripts/development/trade-report.ts`

`configKey` interpolates config fields directly into the group label. A field
absent from an older record renders as the literal string `undefined`, which
reads as "this configuration ran with filters disabled". The true claim is
"these parameters are unknown". Those have opposite implications for whether
the trades are usable.

Change: validate each record against the set of fields `configKey` consumes.
Records missing any field are quarantined — excluded from per-config groups
**and** from the combined total — and reported separately with the specific
missing fields and affected run IDs. `--include-incomplete` restores the old
pooling behaviour for anyone who explicitly wants it.

**Impact on entries/exits/sizing:** none. This is a read-only reporting script
with no path into the trading engine.
**Failure mode introduced:** if the journal schema grows again, previously
readable history drops out of the report. That is the intended direction — the
alternative is a confident verdict over records that cannot support one — but
it means schema additions should be accompanied by a decision about whether to
backfill or accept the history loss.

### C5 — Instrument every exit

Log, on every close: trigger price, observed price at trigger, quoted price,
fill price, modeled impact, realized impact, and latency from trigger to fill.

This is verification for C1–C3, not investigation. It should land alongside them,
not before.

---

## 5. Data disposition

All trades in the current dataset were produced under a configuration whose
take-profit could not execute (Section 2). They do not measure the configured
strategy and must not be used as a baseline.

Two distinct problems, previously conflated here:

1. **All records** — TP was unreachable, so the parameter set under test never
   ran. Affects every trade in the journal.
2. **First four records only** — config snapshot incomplete (see C4). Their
   parameters are unknown. This is a *weaker* objection than originally stated:
   it is a journal schema-version mismatch, not evidence that the run was
   misconfigured.

**Action:** quarantine, do not delete. Retain for comparison against the
post-change baseline — the shift in avg loss by size is the primary evidence
that C1/C2 worked.

The size/loss relationship in Section 1 remains the most reliable signal in this
dataset, because it holds across the records with complete snapshots (0.05 SOL
at -0.52% and 0.5 SOL at -23.29%) and does not depend on the four ambiguous
ones.

---

## 6. Re-baseline protocol

Once C1–C5 are merged:

1. Single configuration. No parallel configs.
2. Single position size.
3. Dry-run only. No live execution authorization is granted or implied by this
   document.
4. Minimum 100 closed trades before reading expectancy, win rate, or profit
   factor. At n=21 a single trade moved config-2 expectancy from +0.192% to
   +0.581%; nothing below n=100 is a signal.
5. Compare avg loss against `stopLossPercent`. If the gap has not closed
   materially, C2's impact model is wrong — fix the model before changing any
   strategy parameter.

Only after avg realized loss approximates the configured stop does parameter
tuning become meaningful. Until then, tuning optimizes noise.

---

## 7. Open questions

- Which component supplies `liquidity` to `generateSignal`, and what is its
  behaviour when the pool is not yet indexed? C1 depends on this returning a
  clear "unknown" rather than 0-as-a-real-value.
- Does `scripts/development/paper-demo.ts` share the production config path?
  It sets `maxSellPriceImpactPercent: 50` against 15 in the unit-test fixtures
  and `exitRetryDelayMs: 0`. If dry-run results come from this path, the
  divergence is itself a measurement problem and belongs in scope.
- Is the +15% ladder activation intentional as the effective profit-taking
  mechanism, or an artifact of the TP gate never passing? This determines
  whether C3 should raise `tp` or whether the ladder should be the documented
  primary exit.

---

## 8. Assumptions

- Round-trip cost on the traded universe exceeds 3%. Inferred from the TP gate
  never passing; not directly measured. C5 measures it.
- ~~Liquidity was among the undefined values in the 0.1 SOL config run.~~
  **Withdrawn.** The undefined values were a journal schema-version mismatch,
  not a runtime config failure (see C4). Nothing is known about that run's
  liquidity handling either way.
- Pool depth decays over the 34–96s hold window. Asserted from the asset class,
  not measured in this codebase. C5's modeled-vs-realized logging tests it.

These are assumptions, not findings. Each should be confirmed before the
corresponding change is treated as validated.
