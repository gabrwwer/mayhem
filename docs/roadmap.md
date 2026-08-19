# Mayhem â€” Production Readiness Roadmap

## Scope note

Two items from the original request are excluded and will not be built:

- **Volume spiker** â€” generating artificial volume is wash trading. Illegal under US CEA Â§4c(a)(2) / MAR Art. 12 and equivalents, and a fast route to venue bans, contract blacklisting, and frozen funds.
- **Chaos manipulator** â€” market manipulation for the same reasons.

Everything else below is legitimate trading infrastructure. Note that "sniping" itself is legal in most
venues but is regulated in some (front-running client flow is not the same as competing on latency);
the design below keeps it to competing on public mempool/listing data only, never on privileged order flow.

Chaos _engineering_ â€” deliberately injecting faults to test resilience â€” is in scope and appears as
`chaos-harness` in Phase 6.

Manipulation logic here is **detection only**: a `manipulation_suspected` risk rule that raises the
risk score and rejects, never a component that creates activity.

---

## Current state

| Thing                                   | State                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `agents/quantum_master_supervisor.yaml` | Valid manifest, validated in CI against `AgentManifestSchema`.                       |
| `packages/core-types/`                  | Domain schemas: primitives, orders, positions/P&L, risk, decisions, manifest.        |
| Toolchain                               | pnpm workspaces, strict TS, ESLint, Prettier, Vitest, secret scan, SBOM. CI green.    |
| `root/`                                 | Current repository root with apps, packages, services, docs, and CI.              |

**There is still no runnable application.** `core-types` is the vocabulary every other
package will be built from; nothing yet trades, prices, or signs.

## Agent manifest production guardrails

All `agents/*.yaml` manifests are treated as production-security artifacts and must satisfy a hard rule set:

- Manifest validation runs in CI via `scripts/validate-manifests.mjs`.
- Orchestrators may not hold `wallet_control`, `access_secrets`, or
  `modify_infrastructure_controls`.
- Orchestrator fallback policy must be `require_human_approval`.
- Human approval gates are mandatory for wallet actions, executive escalation,
  production strategy deploys, and RBAC or permission changes.
- Audit trails must be signed, append-only, and retained for at least ten years.
- `assign_tasks` is true only for supervisor/orchestrator agents; all other agents
  default to safe, read-only behavior.

## Phase 0 â€” Unblock the repo (must happen first)

---

## Phase 0 â€” Unblock the repo (must happen first)

- [x] Replace the orphan root `package-lock.json` with a real workspace root.
- [x] Make `.github/workflows/ci.yml` pass: build at the root, not in the empty `mayhem-bot`.
- [x] Add `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/architecture.md`.
- [ ] **Decide the fate of `mayhem-bot`.** Three options:
  - It's a real repo elsewhere â†’ add `.gitmodules` pointing at it and pin the commit.
  - It was meant to be in-tree â†’ `git rm --cached mayhem-bot`, commit the actual source.
  - It's dead â†’ `git rm --cached mayhem-bot`.
- [ ] Add a `LICENSE`.

## Phase 1 â€” Repo skeleton and toolchain

Target layout (npm workspaces monorepo, TypeScript):

```
package.json                 # workspaces: ["packages/*", "services/*"]
tsconfig.base.json
.nvmrc                       # 22
packages/
  core-types/                # shared domain types, zod schemas
  agent-sdk/                 # base Agent class, lifecycle, heartbeat, RBAC client
  ledger/                    # append-only signed decision trail
  market-data/               # normalized feed adapters
  risk-engine/
  execution/
  accounting/
services/
  supervisor/                # implements agents/quantum_master_supervisor.yaml
  agent-sniper/
  agent-risk-analyst/
  agent-revenue/
  api-gateway/
infra/
  docker/  terraform/  k8s/
config/
  default.yaml  schema.json
scripts/
docs/
  architecture.md  runbooks/  threat-model.md
```

- [x] Root `package.json` with workspaces, `tsconfig.base.json`, strict mode on.
- [x] ESLint (type-aware, strict) + Prettier + `lint:ci` + `format:check`.
- [x] Vitest with a 60% coverage gate, to be ratcheted up.
- [x] `secret-scan` script, `audit:deps`, and CycloneDX `sbom`.
- [x] Pre-commit hooks (husky + lint-staged), running lint-staged and the secret scan.
- [x] Update the Devin blueprint now that `npm install` works.
- [ ] Swap the in-repo secret scanner for gitleaks in CI, keeping the local one as the fast hook.

## Phase 2 â€” Core primitives

- [x] **`packages/core-types`** â€” zod schemas for `OrderIntent`, `Order`, `Fill`, `Position`,
      `PnlSnapshot`, `Recommendation`, `RiskVerdict`, `DecisionRecord`, `ApprovalRequest` and
      `AgentManifest`, plus the order state machine. Amounts are `bigint` in the mint's
      smallest unit; schemas are `.strict()` so an unknown field is an error, not a silent drop.
- [x] **`packages/ledger`** â€” append-only decision trail. Hash-chained entries over a canonical
      encoding, signed through a narrow `LedgerSigner` boundary, with a verifier that walks the
      chain and reports every tampered entry. In-memory and JSONL stores ship; both reject a
      non-contiguous sequence.
- [ ] Ledger: KMS/HSM-backed signer, and an S3 store with Object Lock in compliance mode for the
      manifest's `retention_days: 3650`. A local key satisfies neither.
- [ ] Ledger: verifier CLI, so an operator can check the chain without writing code.
- [ ] **`packages/agent-sdk`** â€” base class providing: 30s heartbeat, capability token
      presentation, structured logging, graceful shutdown, and a `propose()` API that can never
      execute directly (only the execution service can).
- [ ] **RBAC / capability service** â€” enforce the manifest's booleans at runtime. `wallet_control`,
      `access_secrets`, `modify_infrastructure_controls` are `false` for the supervisor; that must
      be enforced by the _system_, not by the supervisor's own good behavior.

## Phase 3 â€” Market data and accounting

- [ ] **`packages/market-data`** â€” adapter interface plus Solana implementations: RPC polling,
      `accountSubscribe`/`logsSubscribe` websockets, and pool-state decoding. Normalize to a
      single tick/book type.
- [ ] Sequence-gap detection, staleness watchdog, automatic reconnect with backoff.
- [ ] Clock discipline (NTP/PTP) â€” latency strategies are meaningless with unsynced clocks.
- [ ] Historical data capture to Parquet/TimescaleDB for backtests.
- [ ] **`packages/accounting`** â€” the "revenue generating" piece done properly: double-entry ledger
      of every fill, fee, funding payment, and gas cost. Realized vs unrealized P&L, per-strategy
      attribution, daily reconciliation against exchange/chain state with a hard alert on drift.
      _You cannot know a strategy makes money without this. Build it before, not after, the strategies._
- [ ] Tax lot tracking (FIFO/HIFO) and exportable reports.

## Phase 4 â€” Risk engine (gates everything downstream)

- [x] **`packages/risk-engine`** â€” synchronous pre-trade check every order must pass: position
      size, per-order notional, strategy and global exposure, concentration, pool participation,
      slippage, daily loss, drawdown, consecutive losses, latency, staleness, sellability,
      manipulation score, quarantine, intent expiry and the kill switch. Missing or stale data
      denies; the engine may shrink an order but never grow one.
- [ ] Wire the engine into an execution path so the gate is unavoidable rather than merely
      available â€” a library nobody is forced to call is not a control.
- [ ] **Kill switch** â€” the engine honours `killSwitchEngaged`, but nothing yet lets a human set
      it without a deploy, and nothing cancels resting orders or flattens.
- [ ] Post-trade monitoring: realized slippage vs expected, fill-rate decay, VaR / expected shortfall.
- [ ] **`services/agent-risk-analyst`** â€” the risk assessment analyst agent: continuously scores
      strategy health (manifest's `evaluate_strategy_health`), flags degradation, feeds the
      supervisor's conflict-resolution ranking with confidence scores.
- [ ] Anomaly detection per the manifest (`sensitivity: high`) â€” behavioral baselining per agent,
      alert + auto-quarantine on deviation.
- [ ] Circuit breakers: on N consecutive losses, on latency spike, on data staleness.

## Phase 5 â€” Execution and the sniper

- [ ] **`packages/execution`** â€” the _only_ component holding signing authority. Everything else
      submits intents. Idempotency keys on every order so retries can't double-fill.
- [ ] Order state machine with reconciliation on restart (recover open orders from the chain,
      never trust local state alone). The state machine itself lives in `core-types`.
- [ ] Blockhash and `lastValidBlockHeight` management, compute-budget and priority-fee
      strategy, and rebroadcast paths. Solana has no account nonce to sequence on.
- [ ] MEV protection: submit through a private relay / Jito bundle so your own orders aren't
      sandwiched.
- [ ] **`services/agent-sniper`** â€” listing/mempool detection â†’ candidate â†’ risk-engine check â†’
      execution intent. Hard rules: honeypot/rug detection (sellability simulation before buying),
      contract-verification check, LP-lock check, max buy tax threshold, per-token capital cap.
- [ ] Simulate every transaction (`simulateTransaction`) before broadcast. No blind sends.
- [ ] Latency budget instrumentation end-to-end (detect â†’ decide â†’ sign â†’ broadcast).

## Phase 6 â€” Supervisor, testing, resilience

- [ ] **`services/supervisor`** â€” implement the manifest: assignment, state, RBAC enforcement,
      conflict resolution with the confidence-margin threshold, audits, simulations,
      HITL approval gates, decision-trail persistence.
- [ ] **HITL approval workflow** â€” real UI/Slack approval for the manifest's four gated actions
      (wallet-affecting actions, executive escalation, strategy production deploys, RBAC changes),
      with timeout â†’ deny, and full audit records. `fallback_policy: require_human_approval` must
      be the actual default code path.
- [ ] **Backtesting harness** â€” event-driven, with realistic fees, latency, and slippage models.
- [ ] **Paper trading mode** â€” same code path, no real funds. Mandatory soak period before live.
- [ ] **`chaos-harness`** â€” fault injection: kill the feed, delay the RPC, drop the DB, partition
      the network, restart mid-order. Assert no double-fills, no orphaned positions, no lost audit entries.
- [ ] Property-based tests on the risk engine and accounting invariants.
- [ ] Deterministic replay from recorded market data for incident reconstruction.

## Phase 7 â€” Security and key custody

- [ ] Threat model doc. Assume a compromised agent process.
- [ ] **Keys never in env vars or files.** KMS/HSM or MPC custody; execution service requests
      signatures, never holds raw keys.
- [ ] Hot/warm/cold wallet split with per-wallet balance caps â€” cap the blast radius.
- [ ] Withdrawal allowlists; multisig for anything above a threshold.
- [ ] Secrets via Vault/KMS with short-lived leases and rotation.
- [ ] Dependency pinning, lockfile audit in CI, provenance/SBOM.
- [ ] Egress allowlisting from execution hosts.
- [ ] External security review before deploying real capital.

## Phase 8 â€” Observability and operations

- [ ] Metrics to the manifest's `mayhem.quantum_supervisor` namespace; Prometheus + Grafana.
- [ ] Structured logs with correlation IDs spanning signal â†’ decision â†’ order â†’ fill â†’ ledger.
- [ ] Distributed tracing (OpenTelemetry).
- [ ] Alerting per the manifest: `anomaly_detected` â†’ critical, `audit_failure` â†’ high. Route to
      real pagers, and test the pages.
- [ ] Dashboards: P&L, exposure, latency, fill quality, agent health, kill-switch state.
- [ ] Runbooks: stuck order, key compromise, venue outage, chain reorg, runaway loss.
- [ ] Staging environment mirroring production against testnet/sandbox venues.
- [ ] Blue/green or canary deploys; strategy rollout behind flags with capital ramping.
- [ ] Backup and restore drill for the ledger and position state.

## Phase 9 â€” Compliance and go-live

- [ ] Legal review of jurisdiction, entity, and licensing for the venues you touch.
- [ ] Confirm each venue's ToS permits automated/latency trading and your API-rate usage.
- [ ] Record-keeping meeting the 10-year retention the manifest already commits to.
- [ ] Go-live checklist with capital ramp: paper â†’ minimum size â†’ 10% â†’ full, with a documented
      revert trigger at each step.

---

## Suggested order

Phase 0 â†’ 1 â†’ 2 â†’ 3 â†’ 4 â†’ 5 â†’ 6 â†’ 7 â†’ 8 â†’ 9.

Do not skip Phase 3 accounting or Phase 4 risk to get to Phase 5 faster. A sniper without a risk
engine and a reconciled P&L is not a money machine, it's an unmonitored way to lose funds quickly.

## Effort estimate

Roughly 12â€“20 Devin sessions of implementation for Phases 0â€“6, assuming venue/RPC credentials and
architectural decisions arrive without long waits. Phases 7 and 9 are gated on external parties
(security review, legal, venue approvals), which is usually the real calendar cost.

## Decisions I need from you

1. `mayhem-bot` â€” real external repo, meant to be in-tree, or dead?
2. Which Solana venues and RPC provider? (Routing and pool decoding differ per DEX.)
3. TypeScript throughout, or Rust for the latency-critical execution path?
4. Which custody provider for the MPC/HSM signing boundary?