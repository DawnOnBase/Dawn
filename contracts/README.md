# Dawn — Smart Contracts

**Owner:** Dawn · **Stack:** Solidity `^0.8.24` + [Foundry] · **Chain:** Base (mainnet `8453`, Sepolia `84532`)

On-chain settlement for Dawn: job escrow, proof-of-execution verification, USDC payout, and protocol-fee collection. `$DAWN` token / staking / governance contracts are **gated to Phase 3** and not in this scaffold yet.

> **Status.** Single-node (`escrow` → `settle`) and redundant (`escrowRedundant` → `submitProof`
> → `claim`) flows implemented: EIP-712 proof verification, bonded M-of-N consensus, pull-based
> reward/slash + fee withdrawal. **28 tests** pass incl. 2 stateful invariants (fund conservation
> across 4096 calls); 99% line / 100% statement coverage.
>
> ⚠️ **Security review found a 🔴 CRITICAL in the redundant flow (no Sybil resistance) — now gated
> off in-contract (`redundantEnabled = false` at deploy) until redesigned; see [`SECURITY.md`](SECURITY.md).
> The single-node flow is sound and is what ships.** Three other findings (settle deadline,
> treasury-DoS, max-deadline lock) are fixed. Deploy steps: [`DEPLOY.md`](DEPLOY.md).

## Two settlement flows

- **Single-node** — `escrow(jobId, amount, deadline)` then `settle(proof, operator)`: verify the
  node's EIP-712 proof, pay operator minus the 0.5% fee.
- **Redundant (M-of-N)** — `escrowRedundant(jobId, amount, deadline, M, bond)`; each node
  `submitProof(proof, operator)` posting `bond`; the **M-th matching `outputHash`** reaches
  consensus and settles. Then `claim(jobId, operator)` (callable by anyone): winners pull
  `reward share + bond`, nodes on a losing hash are **slashed** (bond → treasury), and if no
  consensus by the deadline the buyer `refund`s and submitters reclaim bonds. Pull-based, so no
  unbounded loops.

## Setup

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # if needed
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
forge test
```

## Layout

```
src/Settlement.sol            escrow · verify · payout · fee            [TODO: verify, consensus]
src/interfaces/ISettlement.sol  events + ProofBundle (shared, mirrors packages/shared)
src/interfaces/IERC20.sol       minimal USDC surface
test/Settlement.t.sol         unit tests (escrow/refund done; settle TODO)
script/Deploy.s.sol           deploy script (env-driven)
script/PrintDigest.s.sol      EIP-712 reference values for the TS client cross-check
```

## Deploy (testnet)

```bash
export BASE_SEPOLIA_RPC_URL=... BASESCAN_API_KEY=...
export USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e   # Base Sepolia USDC — verify!
export TREASURY_ADDRESS=0x...
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
```

> Verify all token addresses against Circle's official docs before mainnet (`the architecture` a design decision).

## Next (per the architecture)

- [x] Implement proof verification (EIP-712 typed-data recover, low-s guarded). ✅ Task 1
- [x] Redundant-execution consensus + USDC bonding/slashing (pull-based claim). ✅ Task 2
- [x] Shared web3 client / ABIs + typed bindings (`packages/shared/web3`, viem; EIP-712 cross-checked). ✅ Task 3
- [x] Agent Proof Engine + Payout Manager (Rust; `apps/agent/src/{proof,payout}.rs`; EIP-712 signing cross-checked + adversarially reviewed). ✅ Task 4
- [x] Invariant suite (fund conservation) + coverage + deploy runbook + adversarial security review ([`SECURITY.md`](SECURITY.md)). ✅ Task 5
- [ ] **Resolve 🔴 redundant-consensus design (shared w/ the backend)** or ship single-node only.
- [ ] External audit; fill USDC + treasury addresses at deploy.

[Foundry]: https://book.getfoundry.sh
