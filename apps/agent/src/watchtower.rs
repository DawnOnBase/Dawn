//! Watchtower (M9 Phase 2, `the redundant-execution design` #7 + Phase 2).
//!
//! For every `PendingConsensus` redundant job, the watchtower re-executes the canonical Job Package
//! under the **same** D1 wasmtime runtime the committee used and compares its output to the on-chain
//! consensus. If they disagree it calls `challenge()` before the window closes — the backstop that
//! protects an honest dissenter from a wrong-consensus slash, and the on-ramp to a future
//! re-execution verifier.
//!
//! **v1 identity (ratified):** the contract's `challenge()` is buyer-only (`msg.sender == job.buyer`,
//! and it forfeits the `CHALLENGE_BOND`), so the v1 watchtower runs as the **buyer's own keeper** —
//! configured with the buyer's signing key, per job. A member-/keeper-initiated challenge path
//! (so a third party could run a shared watchtower) is a Phase-2 contract change.
//!
//! **Fail safe, never fail slashing.** A challenge VOIDS consensus → refund + re-run; it must
//! only fire on a *clear* disagreement. Any benign indeterminacy — re-exec error, fetch failure,
//! runtime skew — must NOT challenge (that would grief an honest committee). The decision is pure +
//! unit-tested; the live job source + the on-chain `challenge()` call are seams.

use std::sync::Arc;

use crate::runner::{execute, JobSpec, Sandbox};

/// A `PendingConsensus` job to verify: the work (re-runnable package) + the on-chain consensus it
/// must be checked against, and the moment the challenge window closes.
#[derive(Debug, Clone)]
pub struct PendingJob {
    /// The job's canonical package (module + input), already fetched + content-addressed.
    pub spec: JobSpec,
    /// The on-chain consensus `winningHash` (0x keccak hex) this output is checked against.
    pub winning_hash: String,
    /// Unix seconds when the challenge window closes (`consensusAt + CHALLENGE_WINDOW`).
    pub window_closes_at: i64,
}

/// Source of jobs awaiting verification — fed by the indexer's `JobConsensus` events + the package
/// store. The live impl is (job-queue/indexer); kept a trait so the loop is testable.
pub trait WatchSource {
    fn pending(&mut self) -> Result<Vec<PendingJob>, WatchError>;
}

/// Posts `challenge(jobId)` on-chain (forfeiting the `CHALLENGE_BOND` if the challenge fails). The
/// live impl wraps the Settlement contract (/onchain); kept a trait so decisions are testable.
pub trait Challenger {
    fn challenge(&mut self, job_id: &str) -> Result<(), WatchError>;
}

/// The on-chain JobStatus ordinal for a job frozen at super-plurality, still in the challenge window.
pub const PENDING_CONSENSUS: u8 = 4; // Settlement.JobStatus.PendingConsensus

/// Authoritative on-chain consensus state for a job, read from the Settlement contract. The
/// `IndexerWatchSource` reads this (never the indexer's word alone) before building a `PendingJob`,
/// so a stale/wrong off-chain row can never drive a challenge.
#[derive(Debug, Clone)]
pub struct OnChainConsensus {
    /// Settlement `JobStatus` ordinal (only `PENDING_CONSENSUS` is challengeable).
    pub status: u8,
    /// The on-chain `winningHash` (0x keccak hex) the re-exec is checked against.
    pub winning_hash: String,
    /// `job.consensusAt` (unix seconds) — the challenge window is `consensusAt + CHALLENGE_WINDOW`.
    pub consensus_at: i64,
}

/// Reads a job's authoritative on-chain consensus state. Live impl wraps the Settlement `jobs(...)`
/// getter (/onchain); a trait so the watchtower source is testable without a chain.
pub trait JobReader {
    fn read_job(&self, job_id: &str) -> Result<OnChainConsensus, WatchError>;
}

#[derive(Debug)]
pub enum WatchError {
    Source(String),
    Challenge(String),
}

impl std::fmt::Display for WatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WatchError::Source(m) => write!(f, "watchtower source error: {m}"),
            WatchError::Challenge(m) => write!(f, "watchtower challenge error: {m}"),
        }
    }
}

impl std::error::Error for WatchError {}

/// The outcome of re-executing one pending job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Re-exec reproduced the consensus output — nothing to do.
    Agrees,
    /// Re-exec produced a DIFFERENT output — the consensus is wrong; challenge.
    Disagrees,
    /// The window already closed — too late to challenge (would revert).
    WindowClosed,
    /// Couldn't re-execute (fetch/runtime error). FAIL SAFE: never challenge on indeterminacy.
    Indeterminate,
}

/// One sweep's tally (telemetry + tests).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepReport {
    pub agreed: usize,
    pub challenged: usize,
    pub window_closed: usize,
    pub indeterminate: usize,
    pub challenge_errors: usize,
}

/// Re-executes pending jobs and challenges clear disagreements. Generic over the job source +
/// challenger so the production wiring (indexer-fed source, on-chain challenger) and tests share it.
pub struct Watchtower<S, C> {
    source: S,
    challenger: C,
    sandbox: Arc<dyn Sandbox>,
}

impl<S: WatchSource, C: Challenger> Watchtower<S, C> {
    /// `sandbox` MUST be the same D1 runtime build the committee used (`WasmSandbox`), or honest
    /// agreement would look like disagreement. Pin it fleet-wide ( determinism gate).
    pub fn new(source: S, challenger: C, sandbox: Arc<dyn Sandbox>) -> Self {
        Self {
            source,
            challenger,
            sandbox,
        }
    }

    /// Re-execute one job and decide — pure, no side effects.
    pub fn verify(&self, job: &PendingJob, now: i64) -> Verdict {
        if now >= job.window_closes_at {
            return Verdict::WindowClosed;
        }
        match execute(self.sandbox.as_ref(), &job.spec) {
            Ok(out) if out.output_hash.eq_ignore_ascii_case(&job.winning_hash) => Verdict::Agrees,
            Ok(_) => Verdict::Disagrees,
            Err(_) => Verdict::Indeterminate, // fail safe — a runtime fault is liveness, not fraud
        }
    }

    /// One sweep: pull pending jobs, verify each, and challenge the disagreements. A challenge that
    /// errors is counted but does not abort the sweep (other jobs still get protected).
    pub fn sweep(&mut self, now: i64) -> Result<SweepReport, WatchError> {
        let jobs = self.source.pending()?;
        let mut report = SweepReport::default();
        for job in &jobs {
            match self.verify(job, now) {
                Verdict::Agrees => report.agreed += 1,
                Verdict::WindowClosed => report.window_closed += 1,
                Verdict::Indeterminate => report.indeterminate += 1,
                Verdict::Disagrees => match self.challenger.challenge(&job.spec.job_id) {
                    Ok(()) => report.challenged += 1,
                    Err(_) => report.challenge_errors += 1,
                },
            }
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{keccak_hex, EchoSandbox};

    fn job(input: &[u8], winning: &str, window_closes_at: i64) -> PendingJob {
        PendingJob {
            spec: JobSpec {
                job_id: "0xjob".into(),
                input_ref: "echo://x".into(),
                input: input.to_vec(),
            },
            winning_hash: winning.into(),
            window_closes_at,
        }
    }

    struct VecSource(Vec<PendingJob>);
    impl WatchSource for VecSource {
        fn pending(&mut self) -> Result<Vec<PendingJob>, WatchError> {
            Ok(self.0.clone())
        }
    }

    #[derive(Default)]
    struct RecordingChallenger {
        challenged: Vec<String>,
    }
    impl Challenger for RecordingChallenger {
        fn challenge(&mut self, job_id: &str) -> Result<(), WatchError> {
            self.challenged.push(job_id.to_string());
            Ok(())
        }
    }

    fn watchtower(jobs: Vec<PendingJob>) -> Watchtower<VecSource, RecordingChallenger> {
        Watchtower::new(
            VecSource(jobs),
            RecordingChallenger::default(),
            Arc::new(EchoSandbox),
        )
    }

    #[test]
    fn agrees_when_reexec_matches_consensus() {
        // EchoSandbox echoes input, so output_hash == keccak(input). Consensus matches → no challenge.
        let wt = watchtower(vec![]);
        let j = job(b"hello", &keccak_hex(b"hello"), 1000);
        assert_eq!(wt.verify(&j, 100), Verdict::Agrees);
    }

    #[test]
    fn disagrees_when_consensus_is_wrong() {
        let wt = watchtower(vec![]);
        let j = job(b"hello", &keccak_hex(b"EVIL"), 1000); // consensus claims a different output
        assert_eq!(wt.verify(&j, 100), Verdict::Disagrees);
    }

    #[test]
    fn never_challenges_after_window_closes() {
        let wt = watchtower(vec![]);
        let j = job(b"hello", &keccak_hex(b"EVIL"), 1000);
        // Too late, even though it disagrees.
        assert_eq!(wt.verify(&j, 1000), Verdict::WindowClosed);
    }

    #[test]
    fn sweep_challenges_only_disagreements() {
        let good = job(b"a", &keccak_hex(b"a"), 1000);
        let bad = {
            let mut j = job(b"b", &keccak_hex(b"WRONG"), 1000);
            j.spec.job_id = "0xbad".into();
            j
        };
        let mut wt = watchtower(vec![good, bad]);
        let report = wt.sweep(100).unwrap();
        assert_eq!(report.agreed, 1);
        assert_eq!(report.challenged, 1);
        assert_eq!(wt.challenger.challenged, vec!["0xbad"]);
    }
}
