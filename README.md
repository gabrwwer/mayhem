
# Mayhem

Multi-agent orchestration system for Solana trading, built around a supervisor that
coordinates specialist agents but is never permitted to move funds itself.

> **Status: pre-alpha.** No live capital. The execution, risk, accounting and custody
> layers described in [docs/architecture.md](docs/architecture.md) are not implemented yet.
> See [docs/roadmap.md](docs/roadmap.md) for the sequence and the gates that must pass first.

## Design invariants

These hold system-wide and are enforced in code, not by convention:

- **The supervisor never holds signing authority.** `wallet_control`, `access_secrets` and
  `modify_infrastructure_controls` are denied to any orchestrator, and
  `AgentManifestSchema` rejects a manifest that grants them.
- **Agents propose, they do not execute.** Every agent emits an `OrderIntent`; only the
  execution service turns an intent into a signed transaction.
- **Risk gates every order.** An order cannot reach `signing` without an `approved`
  `RiskVerdict`. Absence of a verdict is a rejection.
- **Everything fails closed.** An expired approval, a stale price and an unreachable risk
  engine all deny.
- **Every decision is recorded.** Decisions are hash-chained and signed in an append-only
  trail with a ten-year retention.

## Repository layout

| Path                    | Contents                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| `agents/`               | Agent manifests (YAML), validated in CI against the runtime schema |
| `packages/core-types/`  | Shared domain types and Zod schemas                                |
| `packages/ledger/`      | Append-only, hash-chained, signed audit trail                      |
| `packages/risk-engine/` | Synchronous pre-trade gate every order passes through              |
| `scripts/`              | Repo tooling: secret scan, SBOM, manifest validation               |
| `docs/`                 | Architecture and roadmap                                           |

## Getting started

Requires Node.js 22.13 or newer (see `.nvmrc`).

```bash
nvm use
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:coverage
```

## Commands

| Command                                   | Purpose                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `pnpm run build`                           | Compile all workspace packages                         |
| `pnpm run typecheck`                       | Type-check packages and tooling configs                |
| `pnpm run lint` / `pnpm run lint:ci`       | ESLint (type-aware, strict)                            |
| `pnpm run format` / `pnpm run format:check`| Prettier                                               |
| `pnpm test` / `pnpm run test:coverage`     | Vitest, with a 60% coverage floor                      |
| `pnpm run validate:manifests`              | Validate `agents/*.yaml` against `AgentManifestSchema` |
| `pnpm run secret-scan`                     | Scan tracked files for credentials                     |
| `pnpm run audit:deps`                      | Fail on high-severity dependency advisories            |
| `pnpm run sbom`                            | Emit a CycloneDX SBOM                                  |

`pnpm run validate:manifests` reads the compiled schema, so run `pnpm run build` first.

## CI

`.github/workflows/ci.yml` now installs and runs at the repository root using pnpm. The repository root workflow is configured for build, lint, formatting, manifest validation, test coverage, and security scans.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).