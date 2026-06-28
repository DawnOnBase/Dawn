# apps/agent — Dawn Desktop Agent

**Stack:** Rust (native, not Electron) · **Platforms:** macOS, Windows, Linux 

The app users install. Runs in userspace only — no kernel extensions, no root. Activates jobs
only during true idle and yields instantly when the user returns.

## Components & ownership (split down the middle)

| Component | Owner | Notes |
|-----------|-------|-------|
| **Idle Detector** | `the backend` | screen lock, lid, input inactivity, battery floor, thermal state |
| **Job Runner** | `the backend` | sandboxed container execution; no host FS/network; sandbox destroyed per job |
| **Proof Engine** | `the agent` | hash input/output, collect metadata, sign with node wallet |
| **Payout Manager** | `the agent` | track accrued USDC, submit proofs, claim payouts on-chain |
| **On-chain client** | `the agent` | `alloy` provider → deployed Settlement (`onchain` feature) |

User controls: max CPU/GPU utilization, thermal limit, battery floor, blackout schedule, one-click pause/resume.

## Layout
- `src/idle.rs` — `IdleConfig` + `Signals` + pure `evaluate()` policy (pause /
  blackout / battery / thermal / instant-yield-on-return). Fully unit-tested.
- `src/runner.rs` — `Sandbox` trait + `execute()` producing the output and the
  keccak256 input/output hashes for the proof bundle. `EchoSandbox` is a
  dev placeholder. Tested against the canonical keccak vector.
- `src/protocol.rs` `[shared]` — Rust mirror of the agent protocol (serde, matching
  the TS `t`-tags + camelCase fields). Round-trip tested.
- `src/proof.rs` — **Proof Engine**: builds the EIP-712 `Proof` digest exactly as
  `Settlement.sol` and signs it with the node wallet (`k256`, low-s, v∈{27,28}). Digest
  cross-checked vs the contract + TS client (`cargo run --example print_digest`).
- `src/payout.rs` — **Payout Manager**: earnings ledger + per-job-isolated submit/claim
  orchestration over a `SettlementRpc` trait (kept sync + node-free so it's unit-testable).
- `src/onchain.rs` — **On-chain client** (`onchain` feature): the production
  `SettlementRpc` — an `alloy` provider against the deployed Settlement contract. `submit` →
  `settle` (single-node, which is what ships), `job_status` → `jobStatus`, `claim` returns the
  inline payout captured from the `JobSettled` event. Bridges to alloy's async API via an owned
  tokio runtime so the Payout Manager stays synchronous. The `sol!` bindings mirror
  `contracts/src/interfaces/ISettlement.sol` (a shared interface).
- `src/main.rs` — wires idle → sandboxed run (demo cycle).

```
cargo test                    # 23 tests — default build (no on-chain deps, builds on rustc 1.89)
cargo test --features onchain # +5 on-chain tests (28 total); needs rustc >= 1.91 (alloy MSRV)
cargo run
```

> The `onchain` feature is off by default to keep the core build light and offline-testable.
> Because `alloy` requires rustc >= 1.91, `apps/agent/rust-toolchain.toml` pins this crate to
> `stable`; it does not change the machine's global default toolchain.

Talks to the backend over the WebSocket protocol in [`packages/shared/src/protocol.ts`](../../packages/shared/src/protocol.ts).

### Follow-ups (tracked)
- Sandbox runtime — Firecracker / gVisor / OCI — **a design decision is OPEN**; `EchoSandbox` until chosen.
- Platform signal probes (input idle, screen lock, battery, thermal) per OS.
- WebSocket transport client (/`[shared]`).
- `alloy` provider behind `SettlementRpc`, plus durable payout state (persist + on-chain reconcile on startup) ().

Status: ** Idle + Runner and Proof Engine + Payout Manager implemented (signing cross-checked vs contract); WS transport, `alloy` RPC, and sandbox runtime are follow-ups.**
