# Mayhem Bot — Deployment & Operations

**Current authorised stage: DRY RUN ONLY.**
Live trading is not authorised. See `docs/development/STRATEGY.md` §7.
Last revised: 2026-08-14

---

## 0. Deployment posture

This system moves real money with no human in the loop. The deployment model
assumes that any defect reaches capital directly, and is built around three
principles:

1. **Fail closed.** Ambiguity halts trading. Never "continue and hope."
2. **Least capital.** Only what the current validation stage justifies is
   reachable by the bot — enforced by wallet balance, not configuration.
3. **Reversible.** Every stage has a tested rollback and a kill switch reachable
   in under 10 seconds.

### 0.1 Authorisation gates

| Stage | `DRY_RUN` | `TRADING_ENABLED` | `NODE_ENV` | Hot wallet | Authorised |
|---|---|---|---|---|---|
| 0 — Measurement | `true` | `false` | `development` | 0 SOL | ✅ |
| 1 — Paper | `true` | `true` | `development` | 0 SOL | ✅ |
| 2 — Micro-live | `false` | `true` | `production` | ≤ 0.5 SOL | ⛔ gated |
| 3 — Scaled | `false` | `true` | `production` | per §5 | ⛔ gated |

Stages 2 and 3 require the corresponding gate in `STRATEGY.md` §7 to have been
cleared **and** an explicit human authorisation recorded in
`docs/operations/AUTHORISATIONS.md`. Neither has occurred.

The config schema partially enforces this: `TRADING_ENABLED=true` with
`DRY_RUN=true` is rejected unless `NODE_ENV=development`
(`packages/config/src/schema.ts`). That refinement is what makes Stage 1 a
distinct, non-accidental state.

---

## 1. Secrets

### 1.1 Private keys are never in environment variables

**This codebase does not read a private key from the environment, and no
deployment may introduce one.**

Keys are loaded from a keyvault directory by identifier:

| Key | Default | Purpose |
|---|---|---|
| `KEYVAULT_DIR` | `/run/secrets/keys` | Directory holding key material |
| `HOT_WALLET_ID` | `hot` | Trading wallet |
| `DEV_WALLET_ID` | `dev` | Deployment/admin |
| `FEE_WALLET_ID` | `fee` | Fee collection |

The keyvault password is read directly at the point of use and is deliberately
**not** part of `BotConfig`, so it cannot be serialised into a config dump, log
line, or crash report.

Any instruction to set `PRIVATE_KEY=<base58>` in `.env` is **obsolete and
prohibited.** It does not work with this codebase, and it puts an unencrypted
signing key in a file that is world-readable by default, copied by every backup,
and trivially exfiltrated by any dependency in the tree.

**Never** run key-encoding one-liners that print the key to stdout. Terminal
history, shell logs, and scrollback all persist it.

### 1.2 Secret handling rules

- `.env` contains **configuration**, never credentials.
- `KEYVAULT_DIR` on a `tmpfs` mount (`/run/secrets`) so key material is not
  written to disk.
- Directory mode `0700`, files `0600`, owned by the service account.
- The service account is **not** a login user and has no shell.
- Rotate the hot wallet on any suspected compromise, on operator change, and on
  a fixed schedule.
- The hot wallet holds only the current stage's capital. Everything else lives
  in a cold wallet the bot has no key for. **This is the real position limit** —
  configuration can be wrong; a wallet with 0.5 SOL in it cannot lose 5.

### 1.3 Secret inventory

| Secret | Storage | Rotation |
|---|---|---|
| Hot wallet key | Keyvault (tmpfs) | On compromise / operator change / 90d |
| Keyvault password | Operator-supplied at start, not persisted | Per rotation |
| `API_KEYS` | Env — bearer tokens for the control API | 90d |
| `INTERNAL_API_SECRET` | Env — HMAC key, bot → API | 90d |
| `PGPASSWORD` | Env or socket peer auth | 90d |
| `TG_BOT_TOKEN` / `DISCORD_WEBHOOK_URL` | Env | On compromise |

---

## 2. Pre-flight checklist

Every item verified before any stage transition. No exceptions, no "it was fine
last time."

**Build integrity**

- [ ] `pnpm install --frozen-lockfile` clean
- [ ] `pnpm build` exits 0
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` — all pass
- [ ] Working tree committed; deployed commit SHA recorded

**Configuration**

- [ ] No duplicate keys in `.env` (dotenv is **last-key-wins**; a stale duplicate
      silently overrides the intended value — this has bitten this project)
- [ ] `DRY_RUN` / `TRADING_ENABLED` / `NODE_ENV` match the authorised stage
- [ ] `MAX_DAILY_LOSS_SOL` ≤ 10% of hot wallet balance
- [ ] `MAX_DRAWDOWN_PCT` < `100 − STOP_LOSS_PCT` (schema-enforced)
- [ ] `RPC_COMMITMENT` is `confirmed` (schema rejects `finalized`)
- [ ] `API_HOST=127.0.0.1` unless a reverse proxy with TLS is in front
- [ ] `API_KEYS` non-empty (schema-enforced in production)

**Risk controls**

- [ ] `MIN_RISK_SCORE` and `MAX_HOLDER_CONCENTRATION_PCT` at real values, not the
      permissive testing values (`0` / `100`) — **these disable the safety checks**
- [ ] `HONEYPOT_SIM_SELL=true`
- [ ] Circuit breaker state restores **closed** on read failure
- [ ] Kill switch tested this deployment (§6)

**Capital**

- [ ] Hot wallet balance ≤ stage limit
- [ ] Cold wallet holds the remainder
- [ ] Wallet address confirmed against the intended address, character by character

**Observability**

- [ ] Alerts deliver (send a test to Telegram/Discord)
- [ ] Postgres reachable; migrations current
- [ ] Trade journal path writable
- [ ] Log destination has disk headroom

---

## 3. Architecture

```
                        ┌──────────────────┐
   operator ───TLS────► │ Reverse proxy    │
                        │ (TLS, auth)      │
                        └────────┬─────────┘
                                 │ 127.0.0.1
                        ┌────────▼─────────┐
                        │ apps/api         │  bearer auth, rate limit
                        │ control + state  │  HMAC on /internal/*
                        └────────┬─────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼────────┐     ┌─────────▼────────┐     ┌─────────▼────────┐
│ apps/bot       │     │ Postgres         │     │ Alerting         │
│                │     │ positions        │     │ TG / Discord     │
│ token-monitor  │     │ breaker state    │     └──────────────────┘
│ risk-engine    │     │ equity snapshots │
│ trading-engine │     │ trade journal    │
│ execution      │     └──────────────────┘
└───────┬────────┘
        │
┌───────▼────────┐   ┌──────────────────┐
│ Solana RPC     │   │ Jito block engine│
│ (3× failover)  │   │                  │
└────────────────┘   └──────────────────┘
```

**Trust boundaries**

| Boundary | Control |
|---|---|
| Operator → API | TLS + bearer token, constant-time compare |
| Bot → API (`/internal/*`) | HMAC-SHA256 over body + timestamp, 30 s replay window |
| Bot → RPC | Outbound only; treat all responses as untrusted input |
| Bot → keyvault | Read-only, tmpfs, service account only |
| Metrics / health ports | **Loopback only** — see §9 |

**No inbound ports are required for trading.** The bot makes only outbound
connections. Any listening socket is an operator convenience and must be bound to
loopback.

---

## 4. Runtime

### 4.1 Process supervision (systemd)

```ini
[Unit]
Description=Mayhem Trading Bot
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=mayhem
Group=mayhem
WorkingDirectory=/opt/mayhem
EnvironmentFile=/opt/mayhem/.env
ExecStart=/usr/bin/node /opt/mayhem/apps/bot/dist/index.js

# Restart, but do not restart-loop into repeated losses
Restart=on-failure
RestartSec=30s
StartLimitBurst=3
StartLimitIntervalSec=600

# Graceful shutdown: flush positions and journal
KillSignal=SIGTERM
TimeoutStopSec=60

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/mayhem/data /var/log/mayhem
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
MemoryMax=2G

StandardOutput=append:/var/log/mayhem/bot.log
StandardError=append:/var/log/mayhem/bot.err

[Install]
WantedBy=multi-user.target
```

**`StartLimitBurst=3` is a safety control, not a convenience.** A bot that
crash-loops while holding positions can re-enter repeatedly. Three failures in
ten minutes stops it and requires a human.

**`TimeoutStopSec=60`** gives the shutdown path time to persist position state.
A `SIGKILL` mid-write is how position state is lost.

### 4.2 Why not PM2

PM2 runs as the invoking user, provides no filesystem or syscall isolation, and
its default restart policy is an unbounded loop — the opposite of the property
required above. systemd is the supported supervisor.

### 4.3 Containers

If containerised: non-root user, read-only root filesystem, no capabilities,
secrets via tmpfs mount (never `--env-file`, never image layers), memory limit,
no published ports.

---

## 5. Capital limits by stage

| Stage | Hot wallet | `SNIPE_POSITION_SOL` | `MAX_CONCURRENT_POSITIONS` | `MAX_DAILY_LOSS_SOL` |
|---|---|---|---|---|
| 1 — Paper | 0 | 0.1 (simulated) | 6 | 1.0 (simulated) |
| 2 — Micro-live | 0.5 | 0.01 | 1 | 0.1 |
| 3a — Scaled | 2.0 | 0.02 | 2 | 0.2 |
| 3b — Scaled | 5.0 | 0.05 | 3 | 0.5 |

Progression requires ≥ 50 closed trades at the prior level reproducing its
expectancy. Any level that fails reverts.

**The hot wallet balance is the binding constraint.** Configuration is a
secondary control that can be mis-set; the wallet cannot lose money it does not
hold.

The previously documented values — 10 SOL per entry, 10 concurrent positions,
50 SOL buybacks — are **prohibited**. That configuration permits >100 SOL of
exposure on a strategy with zero validated trades.

---

## 6. Kill switch

### 6.1 Invocation

```bash
curl -sS -X POST http://127.0.0.1:${API_PORT:-3000}/api/emergency-stop \
  -H "Authorization: Bearer $API_KEY"
```

Verified against `apps/api/src/index.ts:251`. Sets `state.emergencyStop`, which
blocks `/api/start` until explicitly cleared — so a restart cannot silently
resume trading.

Halts new entries immediately. Existing positions exit per §6.2.

Keep this command in the operator's shell history *before* going live. Composing
it correctly for the first time during an incident is not a plan.

### 6.2 Escalation ladder

| Level | Action | Effect | Time |
|---|---|---|---|
| 1 | API kill switch | No new entries; positions managed to normal exits | < 1 s |
| 2 | `emergencyExitAll()` | All positions closed at market, bounded concurrency | seconds |
| 3 | `systemctl stop mayhem-bot` | Graceful stop, state persisted | < 60 s |
| 4 | `systemctl kill -s SIGKILL` | Immediate; **may lose position state** | instant |
| 5 | Rotate hot wallet key | Bot cannot sign; absolute stop | minutes |

Level 5 is the only one that holds against a compromised process. Levels 1–3
assume the bot is behaving correctly.

### 6.3 Automatic halts

The circuit breaker (`packages/risk-engine/src/circuit-breaker.ts`) trips on:

| Trigger | Config key |
|---|---|
| Daily loss | `MAX_DAILY_LOSS_SOL` |
| Consecutive losses | `MAX_CONSECUTIVE_LOSSES` |
| Drawdown | `MAX_DRAWDOWN_PCT` |

Trip state persists (`PERSIST_TRIPS=true`) and **restores closed if the state
read fails.** A breaker that forgets it tripped is worse than no breaker; a
restart must not be a way to resume trading after a halt.

Cooldown (`TRIP_COOLDOWN_MS`, default 1 h) is a floor, not a schedule. Resuming
after a trip requires a human to determine *why* it tripped.

### 6.4 Kill-switch test

Tested at every deployment, before capital is at risk:

1. Start in dry-run
2. Invoke the kill switch
3. Confirm `KILL_SWITCH_ACTIVATED` in logs
4. Confirm no subsequent `ENTRY_*` events
5. Confirm the alert was delivered

An untested kill switch is assumed broken.

---

## 7. Observability

### 7.1 Alert on

| Event | Severity |
|---|---|
| Breaker tripped | Critical |
| Kill switch activated | Critical |
| Position exit failed | Critical |
| Unreconciled position (pending/expired) | Critical |
| Stale price forced exit | High |
| Daily loss > 50% of limit | High |
| RPC failover / sustained 429s | Medium |
| Entry / exit confirmed | Info |

### 7.2 Log discipline

- Structured, one event per line, with timestamp, severity, component, token mint
- **Never** log key material, keyvault passwords, API keys, or HMAC secrets
- Repeating failures suppressed after first occurrence with a periodic summary
  (see `InternalApiClient`) — a log flooded with one recurring error hides
  everything that matters
- Retain ≥ 90 days; trade journal retained indefinitely

### 7.3 Reconciliation

Daily, and after every restart:

- Positions in Postgres vs on-chain token balances
- Journal entries vs closed positions
- Hot wallet balance vs expected equity

**A discrepancy halts trading.** Trading on state you cannot reconcile is how
small bugs become large losses.

---

## 8. Incident response

| Symptom | Immediate action | Then |
|---|---|---|
| Unexpected loss rate | Kill switch (L1) | Read journal; reconcile; do not restart |
| Positions not exiting | `emergencyExitAll` (L2) | Check price source and RPC |
| Position state disagrees with chain | Kill switch; **halt** | Manual reconciliation before any restart |
| Suspected key compromise | Rotate key (L5) | Move funds to cold; full audit |
| RPC degraded | Verify failover | Reduce discovery concurrency |
| Repeated crash | Supervisor stops after 3 | Diagnose before overriding |

**Do not restart a bot you do not understand the failure of.** Restarting is
resuming trading.

### 8.1 Rollback

1. Kill switch
2. Wait for positions to close, or `emergencyExitAll`
3. `systemctl stop`
4. Check out the last known-good commit SHA
5. Rebuild, run the §2 checklist
6. Restart in **dry-run** first, regardless of the prior stage
7. Promote only after confirming clean operation

---

## 9. Known hardening gaps

Tracked, unresolved. Each is a reason Stage 2 is not authorised.

| # | Gap | Risk | Fix |
|---|---|---|---|
| 1 | `apps/bot` reads tunables (`MAX_POSITION_SOL`, etc.) directly via `envNumber`, bypassing `FlatEnvSchema` | Schema's safety invariants are proven about values the bot doesn't use; no bounds check on position size | Move every tunable into `FlatEnvSchema`; read only from `BotConfig` |
| 2 | Bot health server on port 3002 unauthenticated; API `/health` (`apps/api/src/index.ts:184`) also unauthenticated | Information disclosure | Bind loopback; confirm neither leaks position, balance, or config data |
| 3 | Holder concentration unmeasurable for Token-2022 | Pre-graduation tokens entered without concentration data | Compute via `getProgramAccounts` on Token-2022 |
| 4 | Repository is not under version control (**verified**: no `.git` present) | No rollback target; no audit trail; §8.1 step 4 is impossible | `git init`, commit, tag deployments |
| 5 | Dashboard controls do not reach the bot process | Operator believes they have control they lack | Wire through the API, or remove the controls |
| 6 | Signal per `STRATEGY.md` §3.3 not implemented | Entry rule is a single threshold; strategy unvalidated | Implement buy-pressure signal |
| 7 | Testing values `MIN_RISK_SCORE=0`, `MAX_TOP_HOLDER_PERCENT=100` in `.env` | Safety checks effectively disabled | Restore real values before any live stage |

**Gap 4 blocks everything else.** Without version control there is no known-good
commit to roll back to, no record of what was deployed, and no way to bisect a
regression. It should be closed first, and takes minutes.

---

## 10. Change control

| Change | Requirement |
|---|---|
| Strategy parameter | One variable at a time; restarts the validation sample |
| Risk limit (looser) | Written justification; human authorisation |
| Risk limit (tighter) | May be applied immediately |
| Code touching execution/risk/portfolio | Review per `optik-trading-safety-reviewer`; tests; dry-run soak |
| Stage promotion | Gate criteria met; authorisation recorded |
| Emergency tightening | Apply immediately; document within 24 h |

**One variable at a time.** Changing three parameters and observing improvement
tells you nothing about which one mattered, and the sample is unusable for
attribution.

---

## 11. Authorisation record

| Stage | Criteria met | Authorised by | Date |
|---|---|---|---|
| 0 — Measurement | n/a | — | — |
| 1 — Paper | — | — | — |
| 2 — Micro-live | **Not met** | **Not authorised** | — |
| 3 — Scaled | **Not met** | **Not authorised** | — |

---

**No live trading is authorised under this document. Deploying real capital
requires the gates in `docs/development/STRATEGY.md` §7 to be met and an
authorisation recorded above.**
