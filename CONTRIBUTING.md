# Contributing

## Setup

```bash
nvm use          # Node 22.13.x
pnpm install --frozen-lockfile
pnpm run build
```

## Before opening a pull request

```bash
pnpm run build && pnpm run lint:ci && pnpm run format:check && pnpm run test:coverage
pnpm run validate:manifests
pnpm run secret-scan
``
CI runs exactly these, so a green local run should mean a green pipeline.

The pre-commit hook runs `lint-staged` and the secret scan. Do not bypass it with
`--no-verify`.

## Conventions

- TypeScript is strict, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Do not weaken the compiler options to make code compile.
- Validate at process boundaries with the Zod schemas in `@mayhem/core-types`. A type
  assertion is not validation.
- Prefer making an invalid state unrepresentable in the schema over checking for it at
  every call site. Several schemas use `.refine()` for exactly this â€” for example, an
  approved `RiskVerdict` cannot carry breaches.
- Amounts are `bigint` in the mint's smallest unit. Never use `number` for a token
  amount or a lamport balance.
- New packages go under `packages/`, deployable processes under `services/`. Both need a
  `tsconfig.build.json` referenced from the root `tsconfig.build.json`.

## Safety rules

- Never commit a key, a keypair JSON, a mnemonic or an RPC URL with an embedded API key.
- Never grant an orchestrator `wallet_control`, `access_secrets` or
  `modify_infrastructure_controls`.
- Never add a code path that executes a trade without a passing `RiskVerdict`.
- Never make a fail-open default. If a check cannot run, it denies.

## Out of scope

Wash trading, artificial volume generation, coordinated pumps and any other form of market
manipulation will not be accepted. Manipulation logic in this repository is
**detection only**, used to raise risk scores and avoid tokens.
