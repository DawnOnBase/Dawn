<div align="center">

# Dawn

### A passive compute network on **Base**.

Idle machines run sandboxed compute jobs and get paid in **USDC**.
Buyers submit jobs and pay per result. Every payout is proven on-chain and settled atomically.

[![License: MIT](https://img.shields.io/badge/License-MIT-F29B8A.svg)](./LICENSE)
[![Settles on Base](https://img.shields.io/badge/settles%20on-Base-0052FF.svg)](https://base.org)
[![Solidity](https://img.shields.io/badge/Solidity-0.8-363636.svg)](./contracts)
[![Rust](https://img.shields.io/badge/Rust-agent-DEA584.svg)](./apps/agent)
[![Go](https://img.shields.io/badge/Go-job--queue-00ADD8.svg)](./services/job-queue)
[![TypeScript](https://img.shields.io/badge/TypeScript-services%20%26%20sdk-3178C6.svg)](./services)

**[Website](https://dawnonbase.com)** · **[Download the agent](https://dawnonbase.com/download)** · **[SDK](https://github.com/DawnOnBase/SDK)** · **[Settlement contract ↗](https://basescan.org/address/0xc27C681cE93a63C0987226CDaC7b66232018651E)** · **[X](https://x.com/dawnonbase)** · **[Telegram](https://t.me/dawnonbase)**

</div>

---

## Overview

**Dawn** turns idle compute into an open marketplace. An operator installs a lightweight agent;
when their machine is idle it picks up sandboxed [WebAssembly](https://webassembly.org) micro-jobs,
proves it ran them correctly, and is paid in USDC — settled on Base. Buyers submit jobs (directly or
per-request via [x402](https://x402.org)) and only pay for proven results.

The trust model is **on-chain and minimal**: funds are escrowed in a contract, results are proven
with an EIP-712 signature the contract verifies, and payout is atomic. No custody, no off-chain IOUs.

## How it works

```
   ┌─────────┐   escrow USDC    ┌──────────────────────┐   assign    ┌──────────────┐
   │  Buyer  │ ───────────────► │  Settlement (Base)   │             │   Operator   │
   │  / SDK  │                  │  + Dawn coordinator  │ ──────────► │    agent     │
   └─────────┘                  └──────────────────────┘             └──────┬───────┘
        ▲                                  ▲                                 │
        │        proven result            │       settle(proof)              │  run job in a
        └──────────────────────────────── │ ◄─────────────────────────────  │  WASM sandbox,
                                           │      operator paid amount−fee    │  sign EIP-712 proof
                                           └──────────────────────────────────┘
```

1. **Escrow** — a buyer escrows USDC for a job on the `Settlement` contract.
2. **Match** — the coordinator assigns the job to an available operator.
3. **Run** — the operator executes it in a WebAssembly sandbox (no host access).
4. **Prove** — the operator signs an EIP-712 proof of the output.
5. **Settle** — the contract verifies the proof and pays the operator `amount − fee`, atomically.

For high-value work, an **optional redundant mode** runs the job across a committee and settles on
consensus (gated off by default in single-node deployments).

## Monorepo layout

| Path | Stack | What it does |
| --- | --- | --- |
| [`contracts/`](./contracts) | Solidity · Foundry | `Settlement` (escrow → settle → refund → fees) + `OperatorStaking`; tests + a fund-conservation invariant. |
| [`apps/agent/`](./apps/agent) | Rust | The operator agent — idle detection, WASM sandbox runner, EIP-712 proof signing, on-chain self-settle. |
| [`services/api/`](./services/api) | TypeScript · Bun/Fastify | Buyer API — submit jobs, poll results, x402 payments. |
| [`services/job-queue/`](./services/job-queue) | Go | Coordinator — operator presence, matching, dispatch, EIP-191 node auth. |
| [`services/proof-service/`](./services/proof-service) | TypeScript · Bun | Proof verification/recording, consensus, and the settlement sink. |
| [`services/indexer/`](./services/indexer) | TypeScript · Bun | Indexes Base logs into job state in Postgres. |
| [`services/pricing/`](./services/pricing) | TypeScript · Bun | Market-based job pricing + operator reliability scoring. |
| [`packages/shared/`](./packages/shared) | TypeScript | Core protocol types, the viem `Settlement` client, and the EIP-712 domain. |
| [`packages/sdk/`](./packages/sdk) | TypeScript | The buyer SDK (also published standalone at [DawnOnBase/SDK](https://github.com/DawnOnBase/SDK)). |
| [`src/`](./src) | TypeScript · TanStack Start | The Dawn website + download page. |
| [`deploy/`](./deploy) | Docker Compose | Container stack + deployment configs for the backend services. |

## Quickstart

**Prerequisites:** [Foundry](https://getfoundry.sh) (contracts), [Rust](https://rustup.rs) (agent),
[Go](https://go.dev) 1.22+ (job-queue), and [Bun](https://bun.sh) (services + web).

```bash
git clone https://github.com/DawnOnBase/Dawn.git
cd Dawn

# Contracts — build + test (71 tests + invariants)
cd contracts && forge test && cd ..

# The full money path on a local chain (deploy → escrow → run a real WASM job → settle)
bash scripts/e2e_local.sh
```

The [`scripts/e2e_local.sh`](./scripts/e2e_local.sh) run deploys a mock USDC + `Settlement` to a
local Anvil chain, escrows a job, has the agent run a real WebAssembly workload in the wasmtime
sandbox, sign an EIP-712 proof, and self-settle — asserting the operator was paid `amount − fee`
and that the proven output hash matches real compute (not an echo).

## The contract

`Settlement` is live and verified on **Base mainnet**:

> **[`0xc27C681cE93a63C0987226CDaC7b66232018651E`](https://basescan.org/address/0xc27C681cE93a63C0987226CDaC7b66232018651E)**

Core surface: `escrow` (buyer locks USDC), `settle` (verify proof + pay operator), `refund` (after
the deadline), `withdrawFees` (treasury). Money-out paths (`refund` / `withdrawFees`) are never
pausable — the `pause()` circuit breaker only gates new escrows and settlement.

## Build with the SDK

Submitting jobs from your own backend? Use the SDK — [**DawnOnBase/SDK**](https://github.com/DawnOnBase/SDK):

```ts
import { DawnClient } from "@dawnonbase/sdk";

const dawn = new DawnClient("https://api.dawnonbase.com");
const result = await dawn.submitAndWait({ /* ... */ });
```

## Design principles

- **On-chain escrow is the source of truth** — job status derives from contract events, not a database.
- **Prove, don't trust** — every payout requires an EIP-712 proof the contract verifies.
- **Sandboxed by construction** — jobs run in WebAssembly with no access to the host.
- **Self-settling operators** — in single-node mode the operator submits its own settlement; no custodial settler.
- **Fund conservation** — the contract can never pay out more than was escrowed (enforced by an invariant test).

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](./SECURITY.md). Dawn settles
real value on mainnet; responsible disclosure is greatly appreciated.

## Contributing

Contributions are welcome. Each subsystem has its own README with build/test instructions. Please
keep changes typed, tested, and scoped to a single concern.

## License

[MIT](./LICENSE) © Dawn
