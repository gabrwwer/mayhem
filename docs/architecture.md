# Architecture

## Flow

```
                         QUANTUM MASTER SUPERVISOR
                                    |
        +---------------------------+---------------------------+
        |                           |                           |
   ENGINEERING                  SECURITY                     QUANT
     AUDITOR                   SPECIALIST                  RESEARCH
        |                           |                           |
        +---------------------------+---------------------------+
                                    |
                          SOLANA MARKET DATA
                                    |
             +----------------------+----------------------+
             |                      |                      |
       LAUNCH TRACKER           MOMENTUM               LIQUIDITY
             |                      |                      |
             +----------------------+----------------------+
                                    |
                        MANIPULATION DETECTOR        (detection only)
                                    |
                          ALL-AROUNDER ENGINE
                                    |
                             RISK GOVERNOR
                        +-----------+-----------+
                        |                       |
                     REJECT                  APPROVE
                                                |
                                        EXECUTION SERVICE
                                                |
                                          SIMULATION
                                                |
                                         POLICY CHECK
                                                |
                                           MPC / HSM
                                                |
                                          SOLANA RPC
                                                |
                                        RECONCILIATION
                                                |
                                       ACCOUNTING / P&L
                                                |
                                          AUDIT LEDGER
                                                |
                                         OBSERVABILITY
                                                |
                                        QUANT FEEDBACK
```

## Separation of duties

The supervisor decides _what_ should happen; the execution service is the only component
that can _make_ it happen, and only for an intent carrying an approved risk verdict.
Neither can do the other's job:

| Component         | May sign | May approve risk | May direct agents |
| ----------------- | -------- | ---------------- | ----------------- |
| Supervisor        | no       | no               | yes               |
| Strategy agents   | no       | no               | no                |
| Risk governor     | no       | yes              | no                |
| Execution service | yes      | no               | no                |

`AgentManifestSchema` enforces the supervisor's half of this at load time:
an orchestrator granted `wallet_control`, `access_secrets` or
`modify_infrastructure_controls` fails validation, and CI runs that validation on every
manifest.

## Agent manifest strict rules

The system uses a hardened, schema-enforced rule set for every `agents/*.yaml` manifest.
For production readiness, the following constraints are mandatory:

- Orchestrator manifests must:
  - set `role: orchestrator`
  - set `assign_tasks: true`
  - keep `permissions.wallet_control: false`
  - keep `permissions.access_secrets: false`
  - keep `permissions.modify_infrastructure_controls: false`
  - require human approval for:
    - `any_action_affecting_wallets`
    - `escalation_to_executive_controls`
    - `production_deploys_of_strategy`
    - `changes_to_rbac_or_permissions`
  - preserve a signed, append-only audit trail with at least ten-year retention
  - use `decision_policies.fallback_policy: require_human_approval`

- Non-orchestrator agents must:
  - set `assign_tasks: false`
  - avoid any wallet, secret, or infrastructure control permissions
  - remain read-only by default, with write-state capabilities granted only where safe

- All manifests must be validated by `scripts/validate-manifests.mjs` and pass CI.
- `audit.trail_type` must be `append_only_ledger`, `audit.signing` must be `true`, and
  `audit.retention_days` must be at least `3650`.

## Order lifecycle

```
pending_risk -> pending_approval? -> simulating -> signing -> broadcast -> confirmed
      |                 |                |            |           |
 rejected_by_risk  rejected_by_    simulation_      failed      failed
                    approval          failed                    expired
```

Properties the state machine guarantees, covered by tests in
`packages/core-types/src/orders.test.ts`:

- `signing` is unreachable from `pending_risk` directly â€” risk cannot be skipped.
- Terminal states have no outgoing transitions.
- A `broadcast` order cannot be cancelled: once the transaction is on the wire, the
  network decides the outcome.
- `signing` and `broadcast` are the only unresolved states, so those are exactly the
  orders that must be reconciled against the chain after a restart.

Every broadcast carries an idempotency key, so a retry after an ambiguous failure cannot
double-fill.

## Solana specifics

This system targets Solana, so the execution layer works in terms of recent blockhashes
and `lastValidBlockHeight` rather than nonces, priority fees denominated in
micro-lamports per compute unit, `simulateTransaction` before every broadcast, and
confirmation tracking by signature and slot. EVM concepts such as account nonces or
Flashbots bundles do not transfer.

## Fail-closed defaults

| Condition                                   | Result                     |
| ------------------------------------------- | -------------------------- |
| No risk verdict                             | Reject                     |
| Risk engine unreachable                     | Reject                     |
| Market data older than `maxMarketDataAgeMs` | Reject                     |
| Approval request past its deadline          | Deny                       |
| Simulation failure                          | Do not broadcast           |
| Local and on-chain quantities disagree      | Alert; do not auto-correct |

## Audit trail

Decisions are hash-chained (`previousHash` is the SHA-256 of the preceding entry) and
signed, written to object storage under a ten-year retention. The genesis entry is the
only one permitted to omit `previousHash`, so a deleted entry is detectable rather than
merely unlikely.