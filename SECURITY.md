# Security Policy

Dawn settles real value in **USDC on Base mainnet**. We take the security of the
protocol — and of the people running nodes and submitting jobs — seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through either channel:

- **GitHub Security Advisories** — [open a private advisory](https://github.com/DawnOnBase/Dawn/security/advisories/new) on this repository.
- **Email** — `security@dawnonbase.cc`.

Please include a description, affected component, and (ideally) a proof-of-concept
or reproduction steps. We aim to acknowledge reports within **48 hours** and to
provide a remediation timeline after triage.

## Scope

Highest priority — anything that can move, lock, or mis-attribute funds:

- **`contracts/`** — `Settlement` (escrow → settle → refund → fees) and `OperatorStaking`.
- **The proof & settlement path** — EIP-712 proof signing/verification across the
  agent, `proof-service`, and `job-queue`.
- **Authentication** — the EIP-191 node handshake and the x402 payment flow.

Out of scope: the marketing site copy, denial-of-service via unrealistic load on a
local dev stack, and issues that require a compromised operator's own machine/keys.

## Live deployment

The Settlement contract is deployed and verifiable on Base mainnet:

- **Settlement:** [`0xc27C681cE93a63C0987226CDaC7b66232018651E`](https://basescan.org/address/0xc27C681cE93a63C0987226CDaC7b66232018651E)

## Safe harbor

We will not pursue legal action against researchers who act in good faith,
follow this policy, avoid privacy violations and service disruption, and give us
reasonable time to remediate before public disclosure. Thank you for helping keep
Dawn safe.
