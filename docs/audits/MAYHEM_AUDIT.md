# MAYHEM â€” Completed Source Audit

Generated from the authoritative repository TXT dump supplied for the rebuild.

## Scope

This audit covered the complete supplied repository representation, including:

- root configuration and workspace wiring
- packages and application entrypoints
- token discovery and Solana provider lifecycle
- risk engine and circuit breaker
- execution simulator and execution boundary
- configuration schema and environment example
- API authentication and runtime state
- agent manifests and capability restrictions
- CI workflows, tests, Docker wiring, and repository scripts
- retained documentation, legacy markers, and generated artifacts

The real `.env` file was present in the dump only as a redacted marker and was never reproduced.

## Corrected Findings

### Circuit breaker

The active implementation is `packages/risk-engine/src/circuit-breaker.ts`.

Corrections:

- drawdown now uses `currentEquityLamports` versus `peakEquityLamports`
- trade P&L no longer acts as a drawdown proxy
- actual equity can be supplied through `updateEquity()`
- administrative reset establishes the current equity as the new peak
- kill switch remains a hard block
- daily loss, loss streak, drawdown, and cooldown gates remain active
- callback failures are isolated from the safety gate
- state exposes both peak and current equity for observability

### Token monitor

Corrections:

- explicit startup state prevents duplicate starts
- providers cannot be added after startup
- partial startup failures attempt provider cleanup
- shutdown uses `Promise.allSettled()` so one provider cannot prevent cleanup of another
- token callbacks remain isolated
- liquidity callbacks are isolated, including rejected promises
- duplicate mint suppression remains bounded

### Solana token provider

Corrections:

- SPL Token and Token-2022 monitoring are retained
- `initializeMint` and `initializeMint2` are handled
- WebSocket listener cleanup is deterministic
- polling lifecycle is bounded and restart-safe
- poll interval and batch size options are actually applied
- RPC retry handling covers rate limits and common transient network/server failures
- signature and mint caches remain bounded
- token supply retains an exact raw representation alongside the compatibility numeric field
- transaction `accountKeys[0]` is no longer treated as the mint creator
- creator provenance is explicitly marked as undetermined when the source transaction does not establish it

### Configuration

Corrections:

- `DRY_RUN` defaults to `true`
- `TRADING_ENABLED` defaults to `false`
- contradictory `DRY_RUN=true` + `TRADING_ENABLED=true` configuration fails validation
- backrun and launch configuration defaults are fail-safe disabled
- malformed boolean values fail validation instead of silently becoming `false`
- `.env.example` now covers the active configuration schema plus explicitly labeled application compatibility variables
- real `.env` contents are not included in the rebuild artifact

### Bot runtime

Corrections:

- validated configuration is now the source of truth for dry-run/trading safety flags
- unsupported live execution is rejected before any wallet initialization path can run
- circuit breaker configuration comes from the validated config
- paper-trading equity snapshots are fed into the circuit breaker from the simulator's marked portfolio state
- the application uses the shared token-monitor liquidity monitor instead of a duplicate local stub

### API runtime

Corrections:

- dotenv no longer overrides externally supplied environment variables
- production state-changing endpoints fail closed when authentication is not configured
- `API_AUTH_TOKEN` and validated `API_KEYS` are accepted as bearer credentials
- production CORS defaults to disabled unless explicit origins are configured
- `DRY_RUN=true` prevents the API from reporting trading as enabled

### Build/test wiring

Corrections:

- added the missing root `vitest.config.mts`
- fixed executable Node script shebang placement
- root typecheck no longer incorrectly feeds dashboard JSX through the root Node TypeScript configuration
- root build now builds the active API, bot, and Vite dashboard after package project references
- API `tsconfig.json` now overrides inherited `noEmit` so its build actually produces `dist`
- root dashboard development filter points to the actual dashboard package name

### Infrastructure

Corrections:

- active Dockerfiles use the pnpm lock/workspace files required for frozen installs
- bot and API Docker builds target their actual workspace packages
- dashboard Docker build targets the actual Vite dashboard rather than a nonexistent Next.js standalone output
- obsolete `Dockerfile.txt` is removed

### Repository cleanup

Removed only artifacts supported by direct repository evidence as stale, generated, one-off, or obsolete:

- `.prettierrc.json`
- `.eslintrc.json`
- `anarchbot 1.code-workspace`
- `apply_mayhem_audit_fixes.ps1`
- `rebuild-mayhem-dashboard.ps1`
- `tsconfig.base.mayhem-bot.json`
- `turbo.json`
- stale source-audit marker files
- the dated dashboard backup snapshot
- `packages/core-types/src/schema.ts`, an unexported duplicate runtime configuration implementation contradicted by the active `packages/config` implementation

No wallet, execution, risk, ledger, agent, or security control was removed.

## Safety Invariants

The following remain required:

- `DRY_RUN=true` by default
- `TRADING_ENABLED=false` by default
- live execution remains disabled by the supplied bot runtime
- the Quantum Master Supervisor retains:
  - `wallet_control: false`
  - `access_secrets: false`
  - `modify_infrastructure_controls: false`
- audit agents remain read-only
- human approval gates remain in the manifests
- the circuit breaker remains a hard pre-trade gate
- no private key or credential is embedded in the rebuild script

## Verification Status

### Verified by analysis

- repository dump parsed: 359 file sections
- JSON package/config files parsed successfully
- supplied workflow YAML parsed successfully
- six agent manifests parsed successfully
- no active-code `mayhem-bot` reference was found outside documentation/retained README text
- no `packages/rc` active source path exists; the only reference was in the obsolete audit patch script
- `.env` dump content was only a redacted marker
- root TypeScript configuration was statically checked far enough to confirm the prior MJS shebang parse errors are removed after the correction

### Requires local validation

Dependency installation and full compilation/test execution could not be performed in the audit environment because the environment could not reach the npm registry and the repository did not contain installed dependencies.

Run the validation commands in the final audit instructions after reconstruction.