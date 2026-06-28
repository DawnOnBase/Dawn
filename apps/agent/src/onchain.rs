//! On-chain Settlement client  — the production
//! [`SettlementRpc`] backed by an `alloy` provider against the deployed Settlement
//! contract.
//!
//! Behind the non-default `onchain` cargo feature so the default agent build (idle
//! detector, runner, proof/payout orchestration) stays light and offline-testable.
//! The Payout Manager stays synchronous; this bridges to alloy's async API through a
//! dedicated single-thread tokio runtime owned by the client.
//!
//! **Scope: the single-node flow (`escrow` → `settle`), which is what ships** — the
//! redundant flow is gated off in-contract (see `contracts/SECURITY.md`). `submit`
//! calls `settle`, which pays the operator `amount − fee` in the *same* transaction;
//! there is no separate on-chain claim for single-node jobs, so `claim` returns the
//! already-paid payout captured from the `JobSettled` event rather than making a
//! second call. The Solidity bindings below must mirror
//! `contracts/src/interfaces/ISettlement.sol` exactly (a shared interface).

use std::collections::HashMap;

use alloy::network::ReceiptResponse;
use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::transports::http::reqwest;

use crate::payout::{OnchainStatus, PayoutError, RedundantRpc, SettlementRpc, StakingRpc};
use crate::protocol::ProofBundle;
use crate::watchtower::{Challenger, JobReader, OnChainConsensus, WatchError};

sol! {
    #[sol(rpc)]
    #[allow(missing_docs)]
    contract Settlement {
        enum JobStatus { None, Escrowed, Settled, Refunded, PendingConsensus, Challenged }

        struct ProofBundle {
            bytes32 jobId;
            bytes32 inputHash;
            bytes32 outputHash;
            bytes metadata;
            bytes nodeSignature;
        }

        event JobSettled(bytes32 indexed jobId, address indexed operator, uint256 payout, uint256 fee);

        function settle(ProofBundle proof, address operator) external;
        // M9 redundant: Merkle-gated submit. `merkleProof` proves `operator` is in the
        // orchestrator-signed committee; the contract locks the bond from its stake.
        function submitProof(ProofBundle proof, address operator, bytes32[] merkleProof) external;
        // M9 watchtower: void a wrong PendingConsensus (posts the CHALLENGE_BOND).
        function challenge(bytes32 jobId) external;
        function jobStatus(bytes32 jobId) external view returns (JobStatus);
        // M9 watchtower read: the authoritative Job tuple. `status` is declared uint8 (the enum's
        // ABI encoding) so we read the raw ordinal; field order MUST match Settlement.Job.
        function jobs(bytes32 jobId) external view returns (
            address buyer, uint256 amount, uint64 deadline, uint8 status, uint16 redundancy,
            uint256 bond, bytes32 winningHash, uint256 rewardPerWinner, bytes32 inputHash,
            bytes32 operatorSetRoot, uint16 quorum, uint64 consensusAt, bool consensusFinalized
        );
    }
}

sol! {
    #[sol(rpc)]
    #[allow(missing_docs)]
    contract OperatorStaking {
        function stake(uint256 amount) external;
        function freeStake(address operator) external view returns (uint256);
    }
}

sol! {
    #[sol(rpc)]
    #[allow(missing_docs)]
    contract IERC20 {
        function approve(address spender, uint256 amount) external returns (bool);
    }
}

/// Production [`SettlementRpc`]: an alloy contract handle + a runtime to drive it.
pub struct OnchainSettlement {
    rt: tokio::runtime::Runtime,
    contract: Settlement::SettlementInstance<DynProvider>,
    /// jobId(hex) -> payout (USDC base units) captured from `JobSettled` at settle time.
    /// Drained by `claim` since single-node settle pays the operator inline.
    settled_payouts: HashMap<String, u128>,
}

impl OnchainSettlement {
    /// Connect to `settlement` (a deployed Settlement address) over `rpc_url`, sending
    /// transactions from `signer_key` (a 0x hex secp256k1 private key — the gas payer;
    /// for single-node `settle` this need not be the operator being paid).
    pub fn new(rpc_url: &str, settlement: &str, signer_key: &str) -> Result<Self, PayoutError> {
        // Multi-thread (not current-thread): reqwest/hyper's connection task must be
        // driven on a worker while `block_on` parks the calling thread, else requests
        // hang/fail with "error sending request".
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| PayoutError::Rpc(format!("tokio runtime: {e}")))?;

        let signer: PrivateKeySigner = signer_key
            .parse()
            .map_err(|e| PayoutError::Convert(format!("signer key: {e}")))?;
        let url: reqwest::Url = rpc_url
            .parse()
            .map_err(|e| PayoutError::Convert(format!("rpc url: {e}")))?;

        let address = to_addr(settlement, "settlement")?;

        // Build the provider (and its reqwest/hyper HTTP client) WITH `rt` entered as
        // the ambient runtime, so the client binds to the runtime that later drives it
        // via `block_on`. Constructed outside any runtime, hyper can't spawn its
        // connection task and every request fails with "error sending request".
        let provider = {
            let _guard = rt.enter();
            ProviderBuilder::new()
                .wallet(signer)
                .connect_http(url)
                .erased()
        };

        Ok(Self {
            rt,
            contract: Settlement::new(address, provider),
            settled_payouts: HashMap::new(),
        })
    }
}

impl SettlementRpc for OnchainSettlement {
    fn submit(&mut self, proof: &ProofBundle, operator: &str) -> Result<(), PayoutError> {
        let p = to_proof(proof)?;
        let op = to_addr(operator, "operator")?;
        let job_key = proof.job_id.clone();

        let receipt = {
            let contract = &self.contract;
            self.rt.block_on(async move {
                let pending = contract
                    .settle(p, op)
                    .send()
                    .await
                    .map_err(|e| PayoutError::Rpc(format!("settle send: {e}")))?;
                pending
                    .get_receipt()
                    .await
                    .map_err(|e| PayoutError::Rpc(format!("settle receipt: {e}")))
            })?
        };

        if !receipt.status() {
            return Err(PayoutError::Rpc(format!(
                "settle reverted (tx {:#x})",
                receipt.transaction_hash()
            )));
        }

        // Best-effort: record what was actually paid so `claim` can report it. A decode
        // miss only loses the telemetry figure, never the (already-completed) payout.
        for log in receipt.logs() {
            if let Ok(decoded) = log.log_decode::<Settlement::JobSettled>() {
                if let Ok(payout) = u128::try_from(decoded.inner.data.payout) {
                    self.settled_payouts.insert(job_key, payout);
                }
                break;
            }
        }
        Ok(())
    }

    fn claim(&mut self, job_id: &str, _operator: &str) -> Result<u128, PayoutError> {
        // Single-node: `settle` already paid the operator during `submit`. There is no
        // second on-chain claim, so return (and consume) the captured payout.
        Ok(self.settled_payouts.remove(job_id).unwrap_or(0))
    }

    fn job_status(&self, job_id: &str) -> Result<OnchainStatus, PayoutError> {
        let id = to_b32(job_id, "jobId")?;
        let contract = &self.contract;
        let status = self.rt.block_on(async move {
            contract
                .jobStatus(id)
                .call()
                .await
                .map_err(|e| PayoutError::Rpc(format!("jobStatus: {e}")))
        })?;
        Ok(map_status(u8::from(status)))
    }
}

impl RedundantRpc for OnchainSettlement {
    fn submit_redundant(
        &mut self,
        proof: &ProofBundle,
        operator: &str,
        merkle_proof: &[String],
    ) -> Result<(), PayoutError> {
        let p = to_proof(proof)?;
        let op = to_addr(operator, "operator")?;
        let nodes: Vec<FixedBytes<32>> = merkle_proof
            .iter()
            .map(|h| to_b32(h, "merkleProof"))
            .collect::<Result<_, _>>()?;

        let receipt = {
            let contract = &self.contract;
            self.rt.block_on(async move {
                let pending = contract
                    .submitProof(p, op, nodes)
                    .send()
                    .await
                    .map_err(|e| PayoutError::Rpc(format!("submitProof send: {e}")))?;
                pending
                    .get_receipt()
                    .await
                    .map_err(|e| PayoutError::Rpc(format!("submitProof receipt: {e}")))
            })?
        };
        if !receipt.status() {
            return Err(PayoutError::Rpc(format!(
                "submitProof reverted (tx {:#x})",
                receipt.transaction_hash()
            )));
        }
        Ok(())
    }
}

impl Challenger for OnchainSettlement {
    fn challenge(&mut self, job_id: &str) -> Result<(), WatchError> {
        let id = to_b32(job_id, "jobId").map_err(|e| WatchError::Challenge(e.to_string()))?;
        let contract = &self.contract;
        let receipt = self.rt.block_on(async move {
            let pending = contract
                .challenge(id)
                .send()
                .await
                .map_err(|e| WatchError::Challenge(format!("challenge send: {e}")))?;
            pending
                .get_receipt()
                .await
                .map_err(|e| WatchError::Challenge(format!("challenge receipt: {e}")))
        })?;
        if !receipt.status() {
            return Err(WatchError::Challenge(format!(
                "challenge reverted (tx {:#x})",
                receipt.transaction_hash()
            )));
        }
        Ok(())
    }
}

impl JobReader for OnchainSettlement {
    fn read_job(&self, job_id: &str) -> Result<OnChainConsensus, WatchError> {
        let id = to_b32(job_id, "jobId").map_err(|e| WatchError::Source(e.to_string()))?;
        let contract = &self.contract;
        let job = self
            .rt
            .block_on(async move { contract.jobs(id).call().await })
            .map_err(|e| WatchError::Source(format!("read job {job_id}: {e}")))?;
        Ok(OnChainConsensus {
            status: job.status,
            winning_hash: format!("0x{:x}", job.winningHash),
            consensus_at: job.consensusAt as i64,
        })
    }
}

/// Production [`StakingRpc`]: an OperatorStaking handle + the USDC token (for the one-time
/// approve) + a runtime. A committee member stakes once; the contract locks per-job bonds from it.
pub struct OnchainStaking {
    rt: tokio::runtime::Runtime,
    staking: OperatorStaking::OperatorStakingInstance<DynProvider>,
    usdc: IERC20::IERC20Instance<DynProvider>,
    staking_addr: Address,
}

impl OnchainStaking {
    /// Connect to `staking` (OperatorStaking) + `usdc` over `rpc_url`, signing with `signer_key`
    /// (the operator's key — it owns the stake).
    pub fn new(
        rpc_url: &str,
        staking: &str,
        usdc: &str,
        signer_key: &str,
    ) -> Result<Self, PayoutError> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| PayoutError::Rpc(format!("tokio runtime: {e}")))?;

        let signer: PrivateKeySigner = signer_key
            .parse()
            .map_err(|e| PayoutError::Convert(format!("signer key: {e}")))?;
        let url: reqwest::Url = rpc_url
            .parse()
            .map_err(|e| PayoutError::Convert(format!("rpc url: {e}")))?;
        let staking_addr = to_addr(staking, "staking")?;
        let usdc_addr = to_addr(usdc, "usdc")?;

        let provider = {
            let _guard = rt.enter();
            ProviderBuilder::new()
                .wallet(signer)
                .connect_http(url)
                .erased()
        };

        Ok(Self {
            rt,
            staking: OperatorStaking::new(staking_addr, provider.clone()),
            usdc: IERC20::new(usdc_addr, provider),
            staking_addr,
        })
    }
}

impl StakingRpc for OnchainStaking {
    fn free_stake(&self, operator: &str) -> Result<u128, PayoutError> {
        let op = to_addr(operator, "operator")?;
        let staking = &self.staking;
        let free = self.rt.block_on(async move {
            staking
                .freeStake(op)
                .call()
                .await
                .map_err(|e| PayoutError::Rpc(format!("freeStake: {e}")))
        })?;
        u128::try_from(free).map_err(|_| PayoutError::Convert("freeStake exceeds u128".into()))
    }

    fn stake(&mut self, amount: u128) -> Result<(), PayoutError> {
        let amt = U256::from(amount);
        let staking_addr = self.staking_addr;
        let usdc = &self.usdc;
        let staking = &self.staking;

        let receipt = self.rt.block_on(async move {
            // Approve the vault to pull `amount`, then stake it (two txs, sequential).
            let approve = usdc
                .approve(staking_addr, amt)
                .send()
                .await
                .map_err(|e| PayoutError::Rpc(format!("approve send: {e}")))?;
            let approve_rcpt = approve
                .get_receipt()
                .await
                .map_err(|e| PayoutError::Rpc(format!("approve receipt: {e}")))?;
            if !approve_rcpt.status() {
                return Err(PayoutError::Rpc("USDC approve reverted".into()));
            }
            let pending = staking
                .stake(amt)
                .send()
                .await
                .map_err(|e| PayoutError::Rpc(format!("stake send: {e}")))?;
            pending
                .get_receipt()
                .await
                .map_err(|e| PayoutError::Rpc(format!("stake receipt: {e}")))
        })?;

        if !receipt.status() {
            return Err(PayoutError::Rpc(format!(
                "stake reverted (tx {:#x})",
                receipt.transaction_hash()
            )));
        }
        Ok(())
    }
}

/// Map the Solidity `JobStatus` discriminant onto [`OnchainStatus`]. Order mirrors the
/// enum in `ISettlement.sol`; an unknown value degrades to `None`.
fn map_status(raw: u8) -> OnchainStatus {
    match raw {
        1 => OnchainStatus::Escrowed,
        2 => OnchainStatus::Settled,
        3 => OnchainStatus::Refunded,
        _ => OnchainStatus::None,
    }
}

fn to_b32(s: &str, field: &'static str) -> Result<FixedBytes<32>, PayoutError> {
    s.parse::<FixedBytes<32>>()
        .map_err(|e| PayoutError::Convert(format!("{field}: {e}")))
}

fn to_bytes(s: &str, field: &'static str) -> Result<Bytes, PayoutError> {
    s.parse::<Bytes>()
        .map_err(|e| PayoutError::Convert(format!("{field}: {e}")))
}

fn to_addr(s: &str, field: &'static str) -> Result<Address, PayoutError> {
    s.parse::<Address>()
        .map_err(|e| PayoutError::Convert(format!("{field}: {e}")))
}

fn to_proof(p: &ProofBundle) -> Result<Settlement::ProofBundle, PayoutError> {
    Ok(Settlement::ProofBundle {
        jobId: to_b32(&p.job_id, "jobId")?,
        inputHash: to_b32(&p.input_hash, "inputHash")?,
        outputHash: to_b32(&p.output_hash, "outputHash")?,
        metadata: to_bytes(&p.metadata, "metadata")?,
        nodeSignature: to_bytes(&p.node_signature, "nodeSignature")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_job_status_to_onchain_status() {
        assert_eq!(map_status(0), OnchainStatus::None);
        assert_eq!(map_status(1), OnchainStatus::Escrowed);
        assert_eq!(map_status(2), OnchainStatus::Settled);
        assert_eq!(map_status(3), OnchainStatus::Refunded);
        assert_eq!(map_status(42), OnchainStatus::None);
    }

    #[test]
    fn sol_enum_discriminants_match_solidity_order() {
        // If alloy/Solidity ever reorder, this catches the drift before it mis-maps status.
        assert_eq!(u8::from(Settlement::JobStatus::None), 0);
        assert_eq!(u8::from(Settlement::JobStatus::Escrowed), 1);
        assert_eq!(u8::from(Settlement::JobStatus::Settled), 2);
        assert_eq!(u8::from(Settlement::JobStatus::Refunded), 3);
    }

    #[test]
    fn converts_valid_fields() {
        let b32 = format!("0x{}", "11".repeat(32));
        assert!(to_b32(&b32, "jobId").is_ok());
        let addr = format!("0x{}", "ab".repeat(20));
        assert!(to_addr(&addr, "operator").is_ok());
        assert!(to_bytes("0xdeadbeef", "metadata").is_ok());
        assert!(to_bytes("0x", "metadata").is_ok()); // empty metadata is valid
    }

    #[test]
    fn rejects_malformed_fields() {
        assert!(matches!(
            to_b32("0x1234", "jobId"),
            Err(PayoutError::Convert(_))
        )); // too short
        assert!(matches!(
            to_addr("not-an-address", "operator"),
            Err(PayoutError::Convert(_))
        ));
        assert!(matches!(
            to_b32("0xzz", "jobId"),
            Err(PayoutError::Convert(_))
        )); // non-hex
    }

    #[test]
    fn builds_proof_bundle_from_protocol_bundle() {
        let b32 = format!("0x{}", "22".repeat(32));
        let sig = format!("0x{}", "33".repeat(65));
        let bundle = ProofBundle {
            job_id: b32.clone(),
            input_hash: b32.clone(),
            output_hash: b32.clone(),
            metadata: "0x".into(),
            node_signature: sig,
        };
        let p = to_proof(&bundle).expect("valid bundle converts");
        assert_eq!(p.nodeSignature.len(), 65);
        assert!(p.metadata.is_empty());
    }
}
