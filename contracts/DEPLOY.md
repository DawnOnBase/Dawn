# Dawn Settlement — Deploy Runbook

> ✅ **Single-node-only deploy.** `Deploy.s.sol` passes `redundantEnabled = false`, so the redundant
> flow is closed in-contract (`escrowRedundant` reverts `REDUNDANT_DISABLED`) until its consensus
> design is fixed for Sybil resistance — see [`SECURITY.md`](SECURITY.md). The single-node flow is
> sound and is what ships.

## Prerequisites

- Foundry (`forge`, `cast`) + `forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts`
- A funded deployer key on the target chain.
- **Addresses (a design decision — confirm before mainnet):**
  - USDC (Circle, verify against official docs): Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Base mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  - `TREASURY_ADDRESS` — the protocol fee sink (rotatable risk noted in SECURITY.md; pull-based so a bad treasury can't brick settlement)

## 1. Verify locally

```bash
cd contracts
forge test            # 28 tests incl. invariants must pass
forge coverage --report summary
```

## 2. Deploy to Base Sepolia (testnet first)

```bash
export BASE_SEPOLIA_RPC_URL=...        # an RPC URL
export BASESCAN_API_KEY=...            # for --verify
export DEPLOYER_PRIVATE_KEY=...        # funded testnet key
export USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e   # Base Sepolia USDC — verify!
export TREASURY_ADDRESS=0x...
export FEE_BPS=50                      # 0.50% (optional; defaults to 50)

forge script script/Deploy.s.sol \
  --rpc-url base_sepolia \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast --verify
```

The script logs `Settlement deployed: 0x...`.

## 3. Post-deploy

1. Record the address in [`packages/shared/src/web3/addresses.ts`](../packages/shared/src/web3/addresses.ts) (`SETTLEMENT_ADDRESS`).
2. Sanity-check the EIP-712 domain matches the off-chain clients:
   ```bash
   cast call <settlement> "domainSeparator()(bytes32)" --rpc-url base_sepolia
   ```
   It must equal what `packages/shared/web3` and the Rust agent compute for that chainId + address.
3. Confirm verification on Basescan.

## 4. Mainnet

Repeat with `--rpc-url base` and the mainnet USDC address — **only after** an external audit and the
🔴 SECURITY.md item is resolved (or with the redundant flow disabled).
