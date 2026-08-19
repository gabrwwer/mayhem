
# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Jspeer85/mayhem/security/advisories/new).
Do not open a public issue for a security defect.

Please include reproduction steps and the affected commit. Expect an acknowledgement within
three working days.

## Handling a suspected key compromise

Treat as an incident, in this order:

1. Engage the kill switch to halt execution.
2. Rotate the affected key and revoke the old one at the custody provider.
3. Sweep balances to a cold wallet.
4. Preserve the audit ledger and logs before restarting anything.
5. Reconcile positions against on-chain state before resuming.

## Key custody

Private keys must never be committed, written to `.env`, or held in an application
process. The execution service requests signatures from an MPC/HSM/KMS boundary and never
possesses raw key material. Hot wallets carry per-wallet balance caps so a compromise is
bounded.

## Automated checks

Every pull request runs a secret scan, a high-severity dependency audit and SBOM
generation. These are gates, not advisories â€” do not merge around a failure.

An external security review is required before this system is connected to real capital.