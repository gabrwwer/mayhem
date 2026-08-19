# Mayhem Strategy — Specification

**Status: UNVALIDATED HYPOTHESIS. Not cleared for live capital.**
Last revised: 2026-08-14

---

## 0. Validation status (read this first)

This document specifies a strategy. It does **not** report results, because there are none.

| Claim | Status |
|---|---|
| Backtest results | **None exist.** There is no backtest engine in this repository. |
| Live trading results | **None exist.** Zero positions have been opened with real capital. |
| Paper trading results | Partial. Entries executed; no validated profitable sample. |
| Threshold calibration | **Provisional.** Every number below is a starting guess, not a fitted parameter. |

A previous revision of this document contained a "Backtesting Results" table
(432 trades, +127.4% return, Sharpe 1.34) and a "Live Performance" table
(156 trades, 59.6% win rate, +$4,250 P&L). **Those figures were not produced by
any measurement and have been removed.** They are recorded here only so that
nobody reintroduces them from an old copy.

Any parameter in this document marked `[PROVISIONAL]` has not been validated
against data. Promotion to live capital requires clearing §7.

---

## 1. Market model

pump.fun tokens follow a bonding curve with a deterministic price function:

```
price = virtualSolReserves / virtualTokenReserves
```

Reserves move **only** when someone trades. A buy adds SOL and removes tokens,
raising the price; a sell does the inverse. There is no external market maker,
no order book, and no source of price movement other than participant flow.

Two consequences drive the entire strategy:

1. **Reserve delta *is* order flow.** Measuring the change in `virtualSolReserves`
   between two samples measures net buying in that interval, directly. No trade
   feed or API is required — the curve account is the ground truth.
2. **You are part of the price.** Any position you take moves the curve against
   you on entry and again on exit. Position size is not neutral with respect to
   fill quality; it is the dominant term in slippage for small-cap curves.

Observed lifecycle (qualitative, not measured):

| Phase | Characteristic |
|---|---|
| Creation | Creator buy establishes initial reserves |
| Discovery | Snipers and bots enter within seconds |
| Retail | Broader inflow, if the token gets attention at all |
| Distribution | Early entrants sell into later buyers |
| Resolution | Graduation to Raydium, or decay to zero |

**Most tokens never leave Discovery.** The base rate of pump.fun launches that
produce a sustained rise is low, and the strategy must be evaluated against that
base rate, not against the subset that worked.

---

## 2. What changed in this revision

### 2.1 The buyback engine is removed

The prior specification defined a buyback engine that, on a 15% adverse move,
purchased more of the position to "stabilize price" and "create a support level."

**This is removed because the mechanism does not work as described.**

On a bonding curve there is no third-party bid to defend. When the bot buys, it
is the *only* marginal buyer — it moves the price up as it buys, and the price
returns as soon as it stops. No support level is created. The net effect is a
larger position in a declining asset at a worse average cost.

It also directly contradicted the stop-loss: the stop fired at −10% and the
buyback at −15%, so the buyback could only ever trigger on a position that should
already have been closed. Sized as specified (10 SOL entry, 50 SOL buyback), a
single losing trade could reach 6× the intended maximum exposure.

**Replacement invariant — this is now a hard rule:**

> **No averaging down.** A position's cost basis may never increase after entry.
> Adds are permitted only on favourable moves, and only within the position cap.

This is a structural rule, not a tunable. Any future feature that increases
exposure to a losing position is rejected by design.

### 2.2 Thresholds are marked provisional

Prior thresholds (buy pressure > 0.7, hype phase ≥ 3, volatility < 0.5) are
retained as starting points but explicitly labelled unvalidated. They were
presented as validated; they are not.

### 2.3 The strategy is specified against the real architecture

The prior document described modules (`src/bot.ts`, `src/strategies/mayhem.ts`,
`src/services/buyback.ts`) that do not exist. Signal computation is specified
here against the modules that do exist — see §8.

---

## 3. Signal specification

### 3.1 Data source

Sample the bonding curve account directly via `readBondingCurve()`
(`packages/execution/src/pumpfun.ts`). One RPC read per token per sample.

Do **not** source price from the pump.fun HTTP API. It has been observed to fail
and, when it fails silently, produces a constant price that renders every
downstream metric meaningless.

### 3.2 Observation window

| Parameter | Value | Notes |
|---|---|---|
| Sample interval | 2 s `[PROVISIONAL]` | Was 10 s; too coarse to see the Discovery phase |
| Observation window | 60 s `[PROVISIONAL]` | Was 90 s |
| Minimum samples | 10 | Below this, no signal is emitted |

**Known measurement gap:** the current implementation begins sampling when the
token is dequeued for evaluation, not at mint. If the majority of price movement
occurs in the first seconds, the bot systematically observes the decay rather
than the rise. Every token measured so far has shown a negative change, which is
consistent with this hypothesis. **Resolving this is the highest-priority open
question** and is the subject of §7.1.

### 3.3 Derived metrics

Given samples `s[0..n]` of `virtualSolReserves`:

```
delta[i]      = s[i] - s[i-1]

buyPressure   = count(delta[i] > 0) / count(delta[i] != 0)
                → share of intervals with net inflow. Range 0..1.

netFlow       = (s[n] - s[0]) / s[0]
                → total reserve growth over the window.

flowRate      = netFlow / windowSeconds
                → growth per second; comparable across windows.

volatility    = stdev(log(price[i] / price[i-1]))
                → dispersion of returns.

drawdown      = (max(price) - price[n]) / max(price)
                → retracement from window high.
```

`buyPressure` is the core signal. It distinguishes *"rose 2% then stalled"* from
*"is being bought right now"* — a distinction a single percentage-change
threshold cannot make, and the reason the previous entry rule generated no
entries.

### 3.4 Entry conditions

All must hold. `[PROVISIONAL]` — every threshold pending §7.

| Condition | Threshold | Rationale |
|---|---|---|
| `buyPressure` | ≥ 0.65 | Sustained inflow, not a single spike |
| `netFlow` | ≥ +0.02 | Curve actually grew |
| `volatility` | ≤ 0.50 | Reject erratic curves; slippage is unmodellable |
| `drawdown` | ≤ 0.10 | Not already rolling over |
| `samples` | ≥ 10 | Statistical floor |
| Risk gate | PASS | §4 — independent veto |
| Breaker | not tripped | Fail-closed |
| Open positions | < `MAX_CONCURRENT_POSITIONS` | Hard cap |

**Confidence-weighted sizing is deliberately not implemented.** Scaling size by a
confidence score requires that the score be calibrated — that a 0.8 signal wins
more often than a 0.6 signal. That relationship has never been measured here.
Until it is, sizing is flat (§5). Weighting by an uncalibrated score amplifies
variance without improving expectancy.

---

## 4. Risk gate (independent veto)

The signal answers *"is this rising?"* The risk gate answers *"can I get out?"*
They are separate, and the gate is a veto — a strong signal cannot override it.

Implemented in `apps/bot/src/risk-gate-adapter.ts` and
`packages/risk-engine/src/scanner.ts`.

| Check | Config key | Fail behaviour |
|---|---|---|
| Mint authority revoked | `MINT_AUTHORITY` | VETO |
| Freeze authority absent | — | VETO |
| Honeypot sell simulation | `HONEYPOT_SIM_SELL` | VETO |
| Holder concentration | `MAX_HOLDER_CONCENTRATION_PCT` | VETO where measurable |
| Minimum liquidity | `MIN_LIQUIDITY_SOL` | VETO |
| LP lock | `LP_LOCK_REQUIRED` | VETO (post-graduation only) |

**Fail closed.** A check that errors or times out is a failure, not a pass. This
is the single most important property of the gate and must not be relaxed for
throughput.

**Known limitation:** `getTokenLargestAccounts` does not support Token-2022
mints, so holder concentration is *unmeasurable* for most pre-graduation
pump.fun tokens. The scanner marks these `concentrationApplicable: false` and
skips the check rather than failing closed — because failing closed here would
reject 100% of the target universe.

This is a real, accepted gap: **pre-graduation tokens are entered without holder
concentration data.** The compensating controls are the position cap (§5) and the
honeypot simulation. It should be closed by computing concentration from
`getProgramAccounts` on the Token-2022 program.

---

## 5. Position sizing

**Flat fractional. No scaling by signal strength, no scaling by conviction.**

```
positionSize = min(
  SNIPE_POSITION_SOL,
  equity × maxRiskFraction,
  MAX_POSITION_SOL          // see §8.2 — this bypasses schema validation
)
```

| Parameter | Live value | Paper value |
|---|---|---|
| `SNIPE_POSITION_SOL` | 0.05 `[PROVISIONAL]` | 0.1 |
| `MAX_CONCURRENT_POSITIONS` | 3 | 6 |
| Max total exposure | 0.15 SOL | 0.6 SOL |

Live values are deliberately far below the prior specification's 10 SOL entry /
10 concurrent positions. The correct size for a strategy with no measured
expectancy is the smallest size that still produces valid data.

**Sizing is not increased until §7 clears.** Not after a good day, not after a
winning streak. Streaks are the expected behaviour of a random process and are
not evidence.

---

## 6. Exit specification

Exits are unconditional and mechanical. No exit is skipped because the signal
still looks good.

| Rule | Config key | Value | Priority |
|---|---|---|---|
| Stop loss | `STOP_LOSS_PCT` | 15% `[PROVISIONAL]` | 1 (highest) |
| Trailing stop | `TRAILING_STOP_PCT` | 25% from peak | 2 |
| Profit ladder | `SELL_LADDER` | `30@2x,30@3x,40@5x` | 3 |
| Max hold | `MAX_HOLD_SECONDS` | 120 s `[PROVISIONAL]` | 4 |
| Stale price | `maxPriceAgeMs` | force exit | 1 (highest) |

**Stale price is a priority-1 exit.** If the price cannot be read, the position
is unmanageable — the stop-loss cannot fire because there is nothing to compare
against. An unmanageable position is closed, not held. This is implemented with
back-off (`staleExitDeferredUntil`) so a transient RPC failure does not
immediately dump the book.

**Take-profit is evaluated net of fees.** Gross-profit gating on a 3% target
produces losing trades after priority fees, Jito tips, and two-sided slippage. On
small positions, round-trip cost can exceed the entire gross target — which is
why `TAKE_PROFIT_PERCENT=3` combined with a 0.05 SOL position is likely
unprofitable *by construction*, independent of signal quality. Validating this
is part of §7.2.

---

## 7. Promotion gate

The strategy does not progress to the next stage until the stated criterion is
met. **These gates are the reason this document exists.**

### 7.1 Stage 0 — Measurement (current stage)

**Objective:** establish base rates. No trading.

Sample the curve from mint across ≥ 300 launches, recording reserve deltas at 2 s
resolution for 120 s. Produce:

- Distribution of `buyPressure` across all launches
- Distribution of `netFlow` at 15 s / 30 s / 60 s / 120 s
- Fraction of launches that ever rise ≥ 10% from first observation
- For those that do: time-to-peak distribution and post-peak retracement

**Exit criterion:** the above four measurements exist.

**This stage answers whether the strategy is viable at all.** If fewer than a few
percent of launches ever rise meaningfully, and the median time-to-peak is
shorter than the detection latency, no threshold tuning can produce a profitable
system and the approach should be abandoned rather than optimised.

### 7.2 Stage 1 — Paper trading

**Objective:** measure expectancy with thresholds set from Stage 0 data.

**Exit criteria — all required:**

| Criterion | Threshold |
|---|---|
| Closed trades | ≥ 100 |
| Expectancy | > 0 net of modelled fees |
| Profit factor | > 1.3 |
| Max drawdown | < 20% |
| Config stability | No parameter changed during the sample |

The last criterion matters most. Changing a parameter restarts the sample. A
hundred trades across a dozen configurations is not a hundred-trade sample; it is
twelve tiny samples, none of which support a conclusion.

Expectancy: `winRate × avgWin + (1 − winRate) × avgLoss`

### 7.3 Stage 2 — Micro-live

**Objective:** measure the paper-to-live gap.

Minimum viable capital. `SNIPE_POSITION_SOL=0.01`,
`MAX_CONCURRENT_POSITIONS=1`, `MAX_DAILY_LOSS_SOL=0.1`.

**Exit criteria:**

| Criterion | Threshold |
|---|---|
| Closed trades | ≥ 50 |
| Realised slippage vs modelled | within 2× |
| Fill rate | ≥ 80% of attempted entries confirm |
| Expectancy | still > 0 |

The paper-to-live gap is where most strategies die: the simulator does not
model competition for the same block, and a strategy that works on paper can be
consistently front-run in production.

### 7.4 Stage 3 — Scaled

Size increases only after Stage 2 clears, and only in ≤ 2× steps with ≥ 50
trades at each level. Any level that fails to reproduce the prior level's
expectancy reverts to the previous size.

---

## 8. Implementation map

### 8.1 Where each component lives

| Component | Module |
|---|---|
| Curve read / parse | `packages/execution/src/pumpfun.ts` |
| Price + simulated fills | `packages/execution/src/simulator.ts` |
| Bundle submission | `packages/execution/src/jito.ts` |
| Entry/exit orchestration | `packages/trading-engine/src/engine.ts` |
| Position lifecycle | `packages/trading-engine/src/position-manager.ts` |
| Risk scanner | `packages/risk-engine/src/scanner.ts` |
| Circuit breaker | `packages/risk-engine/src/circuit-breaker.ts` |
| Discovery | `packages/token-monitor/src/solana-provider.ts` |
| Risk gate adapter | `apps/bot/src/risk-gate-adapter.ts` |
| Trade journal | `apps/bot/src/trade-journal.ts` |
| Performance report | `scripts/development/trade-report.ts` |

**Not yet implemented:** signal computation as specified in §3.3. The current
entry rule is a single percentage-change threshold. Implementing §3.3 is the
main outstanding code change.

### 8.2 Configuration integrity defect

`packages/config/src/schema.ts` defines a validated, refined schema whose
`superRefine` enforces safety invariants — notably that the circuit breaker
trips before the stop-loss alone could exhaust the day's capital.

`apps/bot/src/index.ts:110` then does:

```ts
const maxPositionSol = envNumber('MAX_POSITION_SOL', Number(config.snipe.positionLamports) / 1e9);
```

`MAX_POSITION_SOL` is **not** a member of `ENV_KEYS`. It is read directly from
the environment, bypassing the schema entirely: no bounds check, no type
validation, no participation in the cross-field safety refinements. The same
pattern applies to other `envNumber` reads in that file.

**Consequence:** the invariants the schema proves at boot are proven about values
the bot does not use. A typo (`MAX_POSITION_SOL=100`) is accepted silently.

**Required fix:** every tunable moves into `FlatEnvSchema`, and `apps/bot`
reads only from the validated `BotConfig`. Until then, treat the schema's
guarantees as advisory. This is tracked as a hardening item in
`docs/deployment/DEPLOYMENT.md` §9.

---

## 9. Failure modes

| Failure | Detection | Mitigation |
|---|---|---|
| Price source fails silently | `PRICE_SOURCE_FAILED` counter | Curve read, not HTTP API; stale-price forced exit |
| RPC rate limiting (429) | Error rate in logs | Discovery budget cap; concurrency limit; failover endpoints |
| Duplicate order submission | Idempotency key | `RejectedError` retried; `AmbiguousSendError` never retried |
| Position state lost on restart | Startup reconciliation | Postgres-backed `PositionStore` |
| Breaker state lost on restart | Startup restore | `BreakerStateStore`, restores **closed** on read failure |
| Partial fill | `filledInputAmount` vs requested | Residual stays open; `originalEntryNotional` fixes the P&L denominator |
| Honeypot | Sell simulation pre-entry | VETO |
| Front-running | Fill rate < 80% at Stage 2 | Gate criterion; abandon if unmet |
| Overfitting to a small sample | Config-change count during sample | Stage gates require config stability |

---

## 10. Explicitly out of scope

| Item | Reason |
|---|---|
| Buyback / price support | Mechanism invalid on a bonding curve (§2.1) |
| Averaging down | Prohibited invariant (§2.1) |
| Confidence-weighted sizing | Requires calibration that does not exist (§3.4) |
| Leverage | No |
| Launching own tokens (`LAUNCH_*`) | Separate system, separate risk profile, separate review |
| Social/sentiment signals | Unverifiable data source; no approved API |

---

## 11. Revision policy

- Any parameter change during an active measurement stage **restarts that stage's sample.**
- Performance figures may be added to this document **only** with a reference to
  the trade journal file and date range that produced them.
- No figure enters this document that was not computed from
  `apps/bot/data/trades.jsonl` by `scripts/development/trade-report.ts`.

---

**Prepared as a specification, not a recommendation. This strategy has no
demonstrated profitability. Trading pump.fun launches carries a high probability
of total loss of deployed capital.**
