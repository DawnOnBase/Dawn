//! Payout Manager .
//!
//! Tracks accrued USDC, submits proofs, and claims payouts. The on-chain calls go
//! through the [`SettlementRpc`] trait so the orchestration is unit-testable without
//! a node; the production implementation wraps an `alloy` provider against the
//! Settlement contract (`packages/shared/web3` is the canonical ABI/seam).

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::protocol::ProofBundle;

/// On-chain job status (mirrors `Settlement.JobStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnchainStatus {
    None,
    Escrowed,
    Settled,
    Refunded,
}

#[derive(Debug)]
pub enum PayoutError {
    /// An off-chain value (bytes32/address/key hex) couldn't be converted to its on-chain form.
    Convert(String),
    /// The settlement RPC call failed: transport error, on-chain revert, or receipt error.
    Rpc(String),
}

impl std::fmt::Display for PayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PayoutError::Convert(msg) => write!(f, "settlement convert error: {msg}"),
            PayoutError::Rpc(msg) => write!(f, "settlement rpc error: {msg}"),
        }
    }
}

impl std::error::Error for PayoutError {}

/// The Settlement contract surface the Payout Manager needs.
///
/// TODO: the production impl wraps `alloy` (submit a tx for `submitProof`
/// /`settle`/`claim`, read `jobStatus`). Kept as a trait so orchestration is testable.
pub trait SettlementRpc {
    /// Submit a proof for a redundant job (or `settle` for single-node).
    fn submit(&mut self, proof: &ProofBundle, operator: &str) -> Result<(), PayoutError>;
    /// Claim a settled job for `operator`; returns USDC claimed in base units (6 dp).
    fn claim(&mut self, job_id: &str, operator: &str) -> Result<u128, PayoutError>;
    /// Current on-chain status of a job.
    fn job_status(&self, job_id: &str) -> Result<OnchainStatus, PayoutError>;
}

/// The OperatorStaking surface an M9 committee member needs: a one-time stake so the contract can
/// lock a per-job bond from it at `submitProof` (M9 doc). Capital-isolation vault, separate
/// from Settlement. [S]/onchain — kept as a trait so the stake-once orchestration is testable.
pub trait StakingRpc {
    /// `operator`'s free (lockable) stake, USDC base units.
    fn free_stake(&self, operator: &str) -> Result<u128, PayoutError>;
    /// Approve + stake `amount` USDC into OperatorStaking (a one-time deposit, not a per-job bond).
    fn stake(&mut self, amount: u128) -> Result<(), PayoutError>;
}

/// Redundant proof submission (Merkle-gated). The PREFERRED redundant path is the proof-service
/// settling on the committee's behalf (M0 D3); this self-submit is the resilience fallback.
pub trait RedundantRpc {
    /// `submitProof(proof, operator, merkleProof)` — the Merkle proof shows `operator` is in the
    /// orchestrator-signed committee, and the contract locks the bond from its stake.
    fn submit_redundant(
        &mut self,
        proof: &ProofBundle,
        operator: &str,
        merkle_proof: &[String],
    ) -> Result<(), PayoutError>;
}

/// Ensures the operator has staked at least `required` USDC before it accepts redundant work,
/// exactly once per process. Idempotent + crash-safe: it re-checks `free_stake` on-chain so a
/// restart after a prior stake does NOT double-deposit.
#[derive(Default)]
pub struct StakeGuard {
    staked: bool,
}

impl StakeGuard {
    pub fn new() -> Self {
        Self { staked: false }
    }

    /// Stake `required` USDC if the operator's on-chain free stake doesn't already cover it.
    pub fn ensure<R: StakingRpc>(
        &mut self,
        rpc: &mut R,
        operator: &str,
        required: u128,
    ) -> Result<(), PayoutError> {
        if self.staked {
            return Ok(());
        }
        if rpc.free_stake(operator)? >= required {
            self.staked = true; // already funded on-chain (e.g. a prior run)
            return Ok(());
        }
        rpc.stake(required)?;
        self.staked = true;
        Ok(())
    }

    /// Whether this process has confirmed sufficient stake.
    pub fn is_staked(&self) -> bool {
        self.staked
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum Phase {
    Submitted,
    Claimed,
}

/// The durable slice of [`PayoutManager`], written to disk so earnings accounting
/// and job tracking survive a crash/restart.
#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistState {
    operator: String,
    total_claimed: u128,
    jobs: HashMap<String, Phase>,
}

/// Tracks this node's jobs and accrued earnings.
pub struct PayoutManager {
    operator: String,
    jobs: HashMap<String, Phase>,
    total_claimed: u128,
    /// When set, state is persisted here after every change (atomic write).
    store_path: Option<PathBuf>,
}

impl PayoutManager {
    /// In-memory only (tests / no-persistence builds).
    pub fn new(operator: impl Into<String>) -> Self {
        Self {
            operator: operator.into(),
            jobs: HashMap::new(),
            total_claimed: 0,
            store_path: None,
        }
    }

    /// Durable: load any prior state for `operator` from `path` and persist future
    /// changes there. State recorded under a different operator is ignored (stale).
    pub fn with_store(operator: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        let operator = operator.into();
        let path = path.into();
        let mut mgr = Self::new(operator.clone());
        mgr.store_path = Some(path.clone());
        // No prior state (first run) is fine — only act on a readable file.
        if let Ok(data) = std::fs::read_to_string(&path) {
            match serde_json::from_str::<PersistState>(&data) {
                Ok(state) if state.operator == operator => {
                    mgr.jobs = state.jobs;
                    mgr.total_claimed = state.total_claimed;
                }
                Ok(_) => eprintln!(
                    "payout: {} holds another operator's state; starting fresh",
                    path.display()
                ),
                Err(e) => eprintln!("payout: ignoring unreadable state {}: {e}", path.display()),
            }
        }
        mgr
    }

    /// Persist current state (best-effort: a disk hiccup logs a warning but never
    /// stops settling, since the on-chain state is the source of truth).
    fn persist(&self) {
        let Some(path) = &self.store_path else {
            return;
        };
        let state = PersistState {
            operator: self.operator.clone(),
            total_claimed: self.total_claimed,
            jobs: self.jobs.clone(),
        };
        if let Err(e) = atomic_write_json(path, &state) {
            eprintln!(
                "payout: WARNING could not persist state to {}: {e}",
                path.display()
            );
        }
    }

    fn track(&mut self, job_id: String, phase: Phase) {
        self.jobs.insert(job_id, phase);
        self.persist();
    }

    /// On startup, reconcile tracked jobs against the chain so accounting survives a
    /// crash between an on-chain settle and the local record: a tracked job already
    /// `Settled` is claimed (draining any captured payout), and a job that's gone or
    /// refunded is dropped. `Escrowed`/transient jobs are left for [`claim_settled`].
    pub fn reconcile<R: SettlementRpc>(&mut self, rpc: &mut R) {
        let tracked: Vec<(String, Phase)> =
            self.jobs.iter().map(|(k, v)| (k.clone(), *v)).collect();
        let mut changed = false;
        for (job_id, phase) in tracked {
            if phase == Phase::Claimed {
                continue;
            }
            match rpc.job_status(&job_id) {
                Ok(OnchainStatus::Settled) => {
                    if let Ok(amount) = rpc.claim(&job_id, &self.operator) {
                        self.total_claimed = self.total_claimed.saturating_add(amount);
                        self.jobs.insert(job_id, Phase::Claimed);
                        changed = true;
                    }
                }
                Ok(OnchainStatus::None) | Ok(OnchainStatus::Refunded) => {
                    self.jobs.remove(&job_id);
                    changed = true;
                }
                _ => {} // Escrowed or transient error — claim_settled will handle it
            }
        }
        if changed {
            self.persist();
        }
    }

    /// Total USDC claimed so far (base units, 6 dp).
    pub fn total_claimed(&self) -> u128 {
        self.total_claimed
    }

    /// Jobs submitted on-chain but not yet claimed.
    pub fn pending_count(&self) -> usize {
        self.jobs
            .values()
            .filter(|p| **p == Phase::Submitted)
            .count()
    }

    /// Submit a completed job's proof. Idempotent: re-submitting a tracked job is a no-op.
    pub fn submit<R: SettlementRpc>(
        &mut self,
        rpc: &mut R,
        proof: &ProofBundle,
    ) -> Result<(), PayoutError> {
        if self.jobs.contains_key(&proof.job_id) {
            return Ok(());
        }
        // Chain-idempotency: if this job is already settled on-chain (e.g. we crashed
        // last run after settling but before recording it), don't settle again — just
        // track it so claim/reconcile can credit the payout.
        if let Ok(OnchainStatus::Settled) = rpc.job_status(&proof.job_id) {
            self.track(proof.job_id.clone(), Phase::Submitted);
            return Ok(());
        }
        rpc.submit(proof, &self.operator)?;
        self.track(proof.job_id.clone(), Phase::Submitted);
        Ok(())
    }

    /// Claim every submitted job that has settled on-chain; returns USDC newly claimed.
    ///
    /// Best-effort and per-job isolated: a transient RPC error (or not-yet-settled status)
    /// on one job is skipped — it stays `Submitted` and is retried next pass — rather than
    /// aborting the batch, so one stuck job can't block claiming the others.
    ///
    /// TODO: state is in-memory only. Persist `jobs`/`total_claimed` and reconcile
    /// from on-chain on startup (treating ALREADY_CLAIMED as already-claimed) so accounting
    /// survives a crash between the on-chain claim and this local update.
    pub fn claim_settled<R: SettlementRpc>(&mut self, rpc: &mut R) -> u128 {
        let submitted: Vec<String> = self
            .jobs
            .iter()
            .filter(|(_, p)| **p == Phase::Submitted)
            .map(|(id, _)| id.clone())
            .collect();

        let mut newly = 0u128;
        let mut changed = false;
        for job_id in submitted {
            match rpc.job_status(&job_id) {
                Ok(OnchainStatus::Settled) => {}
                _ => continue, // not settled yet, or transient error -> retry next pass
            }
            match rpc.claim(&job_id, &self.operator) {
                Ok(amount) => {
                    self.total_claimed = self.total_claimed.saturating_add(amount);
                    newly = newly.saturating_add(amount);
                    self.jobs.insert(job_id, Phase::Claimed);
                    changed = true;
                }
                Err(_) => continue, // leave Submitted; retry next pass
            }
        }
        if changed {
            self.persist();
        }
        newly
    }
}

/// Write `value` as JSON to `path` atomically: serialize to a sibling `.tmp` file,
/// fsync, then rename over the target so a crash mid-write can't truncate state.
fn atomic_write_json<T: Serialize>(path: &std::path::Path, value: &T) -> std::io::Result<()> {
    use std::io::Write;
    let json = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn proof(job_id: &str) -> ProofBundle {
        ProofBundle {
            job_id: job_id.into(),
            input_hash: "0x00".into(),
            output_hash: "0x00".into(),
            metadata: "0x".into(),
            node_signature: "0x".into(),
        }
    }

    #[derive(Default)]
    struct MockRpc {
        submitted: Vec<String>,
        status: HashMap<String, OnchainStatus>,
        claim_amount: u128,
        claimed: Vec<String>,
        fail_claim: HashSet<String>,
    }

    impl SettlementRpc for MockRpc {
        fn submit(&mut self, proof: &ProofBundle, _operator: &str) -> Result<(), PayoutError> {
            self.submitted.push(proof.job_id.clone());
            Ok(())
        }
        fn claim(&mut self, job_id: &str, _operator: &str) -> Result<u128, PayoutError> {
            if self.fail_claim.contains(job_id) {
                return Err(PayoutError::Rpc("transient".into()));
            }
            self.claimed.push(job_id.to_string());
            Ok(self.claim_amount)
        }
        fn job_status(&self, job_id: &str) -> Result<OnchainStatus, PayoutError> {
            Ok(self
                .status
                .get(job_id)
                .copied()
                .unwrap_or(OnchainStatus::Escrowed))
        }
    }

    #[test]
    fn submit_then_claim_when_settled() {
        let mut rpc = MockRpc {
            claim_amount: 49_750_000,
            ..Default::default()
        };
        let mut mgr = PayoutManager::new("0xnode");

        mgr.submit(&mut rpc, &proof("0xjob")).unwrap();
        assert_eq!(rpc.submitted, vec!["0xjob"]);
        assert_eq!(mgr.pending_count(), 1);

        // not settled yet -> no claim
        assert_eq!(mgr.claim_settled(&mut rpc), 0);
        assert_eq!(mgr.total_claimed(), 0);

        // settle on-chain, then claim accrues
        rpc.status.insert("0xjob".into(), OnchainStatus::Settled);
        let newly = mgr.claim_settled(&mut rpc);
        assert_eq!(newly, 49_750_000);
        assert_eq!(mgr.total_claimed(), 49_750_000);
        assert_eq!(mgr.pending_count(), 0);
        assert_eq!(rpc.claimed, vec!["0xjob"]);
    }

    #[test]
    fn does_not_double_claim() {
        let mut rpc = MockRpc {
            claim_amount: 100,
            ..Default::default()
        };
        let mut mgr = PayoutManager::new("0xnode");
        mgr.submit(&mut rpc, &proof("j")).unwrap();
        rpc.status.insert("j".into(), OnchainStatus::Settled);

        assert_eq!(mgr.claim_settled(&mut rpc), 100);
        // second pass: already claimed, nothing new
        assert_eq!(mgr.claim_settled(&mut rpc), 0);
        assert_eq!(mgr.total_claimed(), 100);
        assert_eq!(rpc.claimed.len(), 1);
    }

    #[test]
    fn one_failing_job_does_not_block_others() {
        let mut rpc = MockRpc {
            claim_amount: 100,
            ..Default::default()
        };
        let mut mgr = PayoutManager::new("0xnode");
        mgr.submit(&mut rpc, &proof("good")).unwrap();
        mgr.submit(&mut rpc, &proof("stuck")).unwrap();
        rpc.status.insert("good".into(), OnchainStatus::Settled);
        rpc.status.insert("stuck".into(), OnchainStatus::Settled);
        rpc.fail_claim.insert("stuck".into());

        // "stuck" errors on claim but must not block "good".
        let newly = mgr.claim_settled(&mut rpc);
        assert_eq!(newly, 100);
        assert_eq!(mgr.total_claimed(), 100);
        assert_eq!(mgr.pending_count(), 1); // "stuck" stays submitted for retry
    }

    #[test]
    fn submit_is_idempotent() {
        let mut rpc = MockRpc::default();
        let mut mgr = PayoutManager::new("0xnode");
        mgr.submit(&mut rpc, &proof("j")).unwrap();
        mgr.submit(&mut rpc, &proof("j")).unwrap();
        assert_eq!(rpc.submitted.len(), 1);
    }

    #[test]
    fn already_settled_job_is_not_settled_again() {
        // Models a crash-recovery: the job is already Settled on-chain, so submit must
        // NOT send a second settle (which would revert), just track it.
        let mut rpc = MockRpc::default();
        rpc.status.insert("j".into(), OnchainStatus::Settled);
        let mut mgr = PayoutManager::new("0xnode");
        mgr.submit(&mut rpc, &proof("j")).unwrap();
        assert!(rpc.submitted.is_empty(), "must not re-settle a settled job");
        assert_eq!(mgr.pending_count(), 1); // tracked for claim
    }

    #[derive(Default)]
    struct MockStaking {
        free: u128,
        staked_amounts: Vec<u128>,
    }
    impl StakingRpc for MockStaking {
        fn free_stake(&self, _operator: &str) -> Result<u128, PayoutError> {
            Ok(self.free)
        }
        fn stake(&mut self, amount: u128) -> Result<(), PayoutError> {
            self.staked_amounts.push(amount);
            Ok(())
        }
    }

    #[test]
    fn stake_guard_stakes_once_when_underfunded() {
        let mut rpc = MockStaking::default(); // free = 0
        let mut g = StakeGuard::new();
        g.ensure(&mut rpc, "0xnode", 50_000_000).unwrap();
        g.ensure(&mut rpc, "0xnode", 50_000_000).unwrap(); // second call is a no-op
        assert_eq!(rpc.staked_amounts, vec![50_000_000]);
        assert!(g.is_staked());
    }

    #[test]
    fn stake_guard_skips_when_already_funded_onchain() {
        // Models a restart: stake already on-chain from a prior run -> do NOT double-deposit.
        let mut rpc = MockStaking {
            free: 50_000_000,
            ..Default::default()
        };
        let mut g = StakeGuard::new();
        g.ensure(&mut rpc, "0xnode", 50_000_000).unwrap();
        assert!(
            rpc.staked_amounts.is_empty(),
            "must not re-stake when already funded"
        );
        assert!(g.is_staked());
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("dawn-payout-test-{name}.json"));
        std::fs::remove_file(&p).ok();
        p
    }

    #[test]
    fn state_survives_reload() {
        let path = tmp("reload");
        {
            let mut rpc = MockRpc {
                claim_amount: 100,
                ..Default::default()
            };
            let mut mgr = PayoutManager::with_store("0xnode", &path);
            mgr.submit(&mut rpc, &proof("j")).unwrap();
            rpc.status.insert("j".into(), OnchainStatus::Settled);
            assert_eq!(mgr.claim_settled(&mut rpc), 100);
        }
        // A fresh manager (post-restart) loads the persisted earnings.
        let mgr2 = PayoutManager::with_store("0xnode", &path);
        assert_eq!(mgr2.total_claimed(), 100);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn reconcile_claims_already_settled_jobs() {
        let path = tmp("reconcile");
        // First run: submit (Escrowed), persist as Submitted.
        {
            let mut rpc = MockRpc::default();
            let mut mgr = PayoutManager::with_store("0xnode", &path);
            mgr.submit(&mut rpc, &proof("0xjob")).unwrap();
            assert_eq!(mgr.pending_count(), 1);
        }
        // Restart: the job settled on-chain while we were down.
        let mut rpc = MockRpc {
            claim_amount: 7,
            ..Default::default()
        };
        rpc.status.insert("0xjob".into(), OnchainStatus::Settled);
        let mut mgr = PayoutManager::with_store("0xnode", &path);
        assert_eq!(mgr.pending_count(), 1); // loaded from disk
        mgr.reconcile(&mut rpc);
        assert_eq!(mgr.total_claimed(), 7);
        assert_eq!(mgr.pending_count(), 0);
        // And the claim is persisted.
        assert_eq!(
            PayoutManager::with_store("0xnode", &path).total_claimed(),
            7
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn ignores_other_operators_state() {
        let path = tmp("mismatch");
        {
            let mut rpc = MockRpc {
                claim_amount: 50,
                ..Default::default()
            };
            let mut mgr = PayoutManager::with_store("0xalice", &path);
            mgr.submit(&mut rpc, &proof("j")).unwrap();
            rpc.status.insert("j".into(), OnchainStatus::Settled);
            mgr.claim_settled(&mut rpc);
        }
        // A different operator must not inherit alice's earnings from the same file.
        let mgr_bob = PayoutManager::with_store("0xbob", &path);
        assert_eq!(mgr_bob.total_claimed(), 0);
        std::fs::remove_file(&path).ok();
    }
}
