# Bot Configuration Audit

**Date:** 2026-08-15
**Scope:** `apps/bot/.env` cross-checked against `packages/config/src/schema.ts` and `apps/bot/src/index.ts`
**Method:** every trading-relevant key traced to the code that reads it, and to the value observed in a live dry run (`bot-run.log`)

---

## F1 — CRITICAL: position size and concurrency keys are structurally unreachable

`packages/config/src/schema.ts:276-279`:

```ts
const positionSol = e.MAX_POSITION_SOL ?? e.SNIPE_POSITION_SOL;
const maxConcurrentPositions = e.MAX_OPEN_POSITIONS ?? e.MAX_CONCURRENT_POSITIONS;
const maxDrawdownPct = e.MAX_DRAWDOWN_PERCENT ?? e.MAX_DRAWDOWN_PCT;
const tripCooldownMs = e.BREAKER_COOLDOWN_MS ?? e.TRIP_COOLDOWN_MS;
```

The intent is "prefer the primary key, fall back to the legacy one." The `??`
operator only falls through on `null`/`undefined`.

Every one of these fields is declared with a Zod `.default()`
(`schema.ts:75-105` — `envNum`, `envPct`, `envSol` all end in
`.default(fallback)`). A field with a default is **never undefined after
parsing**. It is populated with the default when the environment variable is
absent.

Therefore the right-hand side of every `??` above is **dead code**. These four
keys can never take effect, whatever the `.env` says:

| unreachable key | key that actually wins | schema default |
|---|---|---|
| `SNIPE_POSITION_SOL` | `MAX_POSITION_SOL` | 0.5 |
| `MAX_CONCURRENT_POSITIONS` | `MAX_OPEN_POSITIONS` | 5 |
| `MAX_DRAWDOWN_PCT` | `MAX_DRAWDOWN_PERCENT` | — |
| `TRIP_COOLDOWN_MS` | `BREAKER_COOLDOWN_MS` | — |

### Confirmed against the running bot

`bot-run.log:20` — `maxPositionSol: 0.5, maxOpenPositions: 5`, while
`.env` set `SNIPE_POSITION_SOL=0.05` and `MAX_CONCURRENT_POSITIONS=2`, and
neither `MAX_POSITION_SOL` nor `MAX_OPEN_POSITIONS` was set at all. Both came
from the schema defaults.

### Why this is the most consequential finding

`.env:193-201` documents, correctly, that:

> a fresh pump.fun curve holds ~30 SOL of virtual reserves, so a 0.5 SOL buy
> moves price ~1.7% going in and ~1.7% coming out. That is ~3.3% of round-trip
> impact against a 3% take-profit target — every trade loses regardless of
> signal quality.

The correct diagnosis was reached, the fix was written down, and it never took
effect. The bot has been running at 0.5 SOL — the size its own documentation
identifies as unprofitable by construction — throughout.

This also explains the historical dataset: all 21 journalled trades carry
`maxPositionSol: 0.5`.

### The `.env` comments are backwards

`.env:187-191` and `:205-206` describe `MAX_POSITION_SOL` and
`MAX_OPEN_POSITIONS` as *"DEAD KEY — not in FlatEnvSchema"*. Both ARE in
`FlatEnvSchema` (`schema.ts:177, 180`), and both are the keys that win. The
comments assert the exact inverse of the behaviour.

### Fix

Immediate, in `.env`: set `MAX_POSITION_SOL` and `MAX_OPEN_POSITIONS`, since
those are the keys that are read. Correct the misleading comments.

Proper, in `schema.ts`: the legacy-fallback pattern cannot work against
defaulted fields. Either drop the defaults on the primary keys and make them
`.optional()`, so `??` behaves as intended, or delete the dead alternatives and
keep one key per concept. The second is preferable — two names for one setting
is what produced this.

**Verification:** on next start, `Mayhem Bot fully started` must report
`maxPositionSol: 0.05` and `maxOpenPositions: 2`.

---

## F2 — HIGH: wallet password stored in plaintext

`.env:173` contains `WALLET_PASSWORD=` with a literal password, alongside
`WALLET_PROVIDER=encrypted_local` and `WALLET_FILE_PATH` pointing at a
keystore.

An encrypted keystore whose password sits in a world-readable file beside it
provides the protection of an unencrypted key. `.env` is gitignored
(`.gitignore:10-11`), so this is not in version control — the exposure is local
disk, backups, and any process able to read the file.

**Fix:** move to an OS keychain, a secrets manager, or an interactive prompt.
At minimum this must not be present before any non-dry-run execution.

**Related:** `.env:490` holds `INTERNAL_API_SECRET` in the same file.

---

## F3 — HIGH: risk gate is fully open

| key | value | effect |
|---|---|---|
| `MIN_RISK_SCORE` | 0 | no minimum score |
| `MIN_LIQUIDITY_SOL` | 0 | no depth floor |
| `MIN_HOLDERS` | 0 | no distribution floor |
| `LP_LOCK_REQUIRED` | false | LP lock not required |
| `HOLDER_VELOCITY_MIN_RATE` | 0 | disabled |
| `MIN_DEV_WALLET_EXPOSURE_DAYS` | 0 | disabled |
| `MAX_HOLDER_CONCENTRATION_PCT` | 80 | permissive |

Observed in the log as `RISK_GATE_PASSED … score: 100` on essentially every
candidate, and `REJECTED_RISK … score: 0, minRiskScore: 0` where the scanner
blocked on a hard check rather than the score.

Only the hard structural checks (`REQUIRE_MINT_AUTHORITY_REVOKED`,
`REQUIRE_FREEZE_AUTHORITY_REVOKED`, `HONEYPOT_SIM_SELL`) are doing any work.

This may be deliberate for a dry-run data-collection phase — an open gate
produces more samples. It must not survive into live trading, and while it is
open, entry-quality statistics describe an unfiltered universe.

---

## F4 — MEDIUM: two slippage settings disagree by 120x

| key | value | consumed by |
|---|---|---|
| `MAX_SLIPPAGE_PCT` | 30 (= 3000 bps) | `config.snipe.maxSlippagePct` — live execution path |
| `SLIPPAGE_BPS` | 25 (= 0.25%) | `SimulatedExecutionEngine` (`index.ts:282`) |

These feed different code paths, so this is not a direct conflict — but the
simulated path models 0.25% while the live path would permit 30%. Any result
measured under the simulator is therefore not indicative of live behaviour, and
the two numbers should be reconciled deliberately rather than by accident.

`MAX_ENTRY_PRICE_IMPACT_BPS=2000` (20%) is similarly permissive and should be
reviewed alongside.

---

## F5 — MEDIUM: take-profit is below round-trip cost

`TAKE_PROFIT_PERCENT=3`, with the TP gate at `engine.ts:554-577` requiring
**net** P&L to clear the same 3%.

At the live 0.5 SOL size (F1) round-trip impact is ~3.3%, so the gate can never
pass and take-profit never executes. Positions ride to the lock ladder, whose
first rung is +15% (`position-manager.ts:14-22`).

Observed: the 21 historical trades show avg win +16.49%, sitting on that rung,
against a configured 3% target. All three trades in the latest run exited via
`time_exit`.

Fixing F1 (0.05 SOL → ~0.33% round trip) makes a 3% target reachable. The two
findings must be resolved together — F5 is a consequence of F1, not an
independent setting.

**Recommended:** add a startup assertion that rejects any config where
`TAKE_PROFIT_PERCENT` is below modelled round-trip cost, so this fails loudly
rather than degrading to ladder-only behaviour.

---

## F6 — MEDIUM: trailing/lock configuration does not match the code

| key | value | code |
|---|---|---|
| `TRAILING_ACTIVATION_PERCENT` | 40 | `Math.max(15, config)` → 40 |
| `PROFIT_LOCK_ACTIVATION_PERCENT` | 30 | **not read** by `PositionManager` |
| `PROFIT_LOCK_PERCENT` | 10 | **not read** by `PositionManager` |

The lock ladder in `position-manager.ts:14-22` is a hardcoded constant
(15/20/25/35/50/75/100 → 10/15/20/27/40/60/80). The two `PROFIT_LOCK_*` keys are
passed into `TradingConfig` but never consulted by the ladder that supersedes
them.

Tuning those keys has no effect. Either wire them into the ladder or remove
them; leaving them present implies a control that does not exist.

---

## F7 — LOW: duplicate key definitions

`SNIPE_POSITION_SOL` (`.env:194`, `:222`) and `MAX_CONCURRENT_POSITIONS`
(`.env:196`, `:234`) are each defined twice with different values.

Moot given F1 — both keys are unreachable regardless — but the file should hold
one definition per key. Two definitions with different values means the file no
longer documents its own behaviour.

---

## F8 — INFO: durable state unavailable

`DATABASE_URL` is set (`.env:385`) but the run logged
`STATE_STORE_UNAVAILABLE` followed by `BREAKER_RESET_ON_START`, meaning
PostgreSQL was not reachable.

Permitted in dry run by design (`index.ts:203`). Live trading throws without
it, correctly — a restart would otherwise clear the circuit breaker and orphan
open positions.

Worth resolving before any extended measurement run: the breaker resets each
restart, so drawdown limits do not accumulate across sessions.

---

## Priority

| # | finding | severity | blocks |
|---|---|---|---|
| F1 | position size unreachable | **critical** | every result to date |
| F2 | plaintext wallet password | **high** | any live execution |
| F3 | risk gate fully open | **high** | any live execution |
| F5 | TP below round-trip cost | medium | consequence of F1 |
| F4 | slippage settings disagree | medium | simulator realism |
| F6 | lock keys not wired | medium | strategy tuning |
| F7 | duplicate keys | low | file clarity |
| F8 | no durable state | info | multi-session runs |

**F1 first.** Every trade recorded so far ran at a position size the project's
own documentation identifies as unprofitable by construction. No strategy
conclusion drawn before it is fixed can be trusted, and no strategy work is
worth doing until it is.
