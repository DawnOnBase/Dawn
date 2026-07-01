# @dawn/shared

**Ownership:** shared (`the agent` + `the backend`) — the single source of truth for cross-cutting
types, the agent↔backend protocol, and the on-chain event spec. **Do not change anything here
without both owners' sign-off** . The API, indexer, agent, and contracts all
depend on these shapes.

## Contents

- [`src/types.ts`](src/types.ts) — `Job`, `JobRequirements`, `NodeProfile`, `ProofBundle`, `JobStatus`, `JobType`.
- [`src/protocol.ts`](src/protocol.ts) — `AgentToBackend` / `BackendToAgent` WebSocket messages.
- [`src/web3/`](src/web3) — viem `SettlementClient`, EIP-712 proof helpers, chain/address config, and the contract ABI ([`abi/Settlement.json`](abi/Settlement.json)). Import from `@dawn/shared/web3` (pulls in `viem`).

## web3 client (`@dawn/shared/web3`)

- **`SettlementClient`** — viem wrapper: reads (`jobStatus`, `proofDigest`), writes (`escrow`,
  `escrowRedundant`, `settle`, `submitProof`, `claim`, `refund`), and `decodeSettlementLogs(logs)` for the indexer.
- **`proofDigest` / `signProof` / `recoverProofSigner`** — EIP-712 helpers identical to the contract.
- **`SETTLEMENT_ADDRESS` / `CHAIN_IDS`** — fill in deployed addresses after the Task 5 deploy.

The TS EIP-712 scheme is verified equal to `Settlement.sol` byte-for-byte by
[`scripts/verify-eip712.ts`](scripts/verify-eip712.ts) against the reference printed by
`forge script script/PrintDigest.s.sol`. the backend's proof-service can use `recoverProofSigner` directly.

## On-chain event spec (mirrors `contracts/src/interfaces/ISettlement.sol`)

| Event | Fields | Consumed by |
|-------|--------|-------------|
| `JobEscrowed` | `jobId, buyer, amount, deadline` | indexer → mark `Escrowed` |
| `JobSettled` | `jobId, operator, payout, fee` | indexer → mark `Settled` (single-node), credit operator |
| `JobRefunded` | `jobId, buyer, amount` | indexer → mark `Refunded` |
| `FeeCollected` | `jobId, fee` | analytics |
| `ProofSubmitted` | `jobId, operator, outputHash` | indexer → track redundant submissions |
| `JobConsensus` | `jobId, winningHash, winners, rewardPerWinner, fee` | indexer → mark `Settled` (redundant) |
| `RewardClaimed` | `jobId, operator, reward, bondReturned` | indexer → credit winner |
| `BondSlashed` | `jobId, operator, bond` | indexer/analytics → node penalty |
| `BondReturned` | `jobId, operator, bond` | indexer → bond reclaimed |

**Redundant execution (M-of-N).** For `JobRequirements.redundancy > 1`, the buyer uses
`escrowRedundant(jobId, amount, deadline, M, bond)`; nodes `submitProof` posting `bond`; the M-th
matching `outputHash` settles. Nodes then `claim` — winners get `reward share + bond`, losing-hash
nodes are slashed (bond → treasury), no-consensus-by-deadline returns bonds + buyer refund. The
proof-service should mirror the same EIP-712 verification before trusting a submission.

**Proof signature — EIP-712 typed data (must match on both sides).** Domain-separated so a node
attestation can't be replayed on another chain or a different deployment:

- **Domain:** `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`
  with `name = "Dawn Settlement"`, `version = "1"`, `chainId` = the Base chain, `verifyingContract` = the Settlement address.
- **Message:** `Proof(bytes32 jobId,bytes32 inputHash,bytes32 outputHash,bytes32 metadataHash)`, where `metadataHash = keccak256(metadata)`.
- The node wallet signs the EIP-712 digest; `nodeSignature = abi.encodePacked(r, s, v)` (65 bytes, low-s / EIP-2 only).

The agent Proof Engine produces it; the Settlement contract (`settle`) and the proof-validation
service verify against this exact scheme. The contract exposes `domainSeparator()` and
`proofDigest(ProofBundle)` as `view`s so off-chain code can cross-check the digest.

> ⚠️ **shared change (was a plain `keccak256(abi.encode(...))` in the scaffold).** the backend: the
> proof-service must verify EIP-712, not a raw struct hash. Implemented + tested in `contracts/`.

> This package intentionally ships types only (no build/package.json yet) so it can be
> consumed directly during scaffolding. Whoever wires up the workspace first should add the
> package manifest + build — coordinate so it stays shared.
