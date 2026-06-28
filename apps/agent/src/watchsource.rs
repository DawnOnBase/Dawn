//! IndexerWatchSource (M9 S2) — feeds the watchtower its `PendingJob`s from three sources: the
//! indexer's `GET /v1/pending-consensus` candidate list, the package store (fetch by `inputRef`),
//! and the **authoritative on-chain consensus state** (status / winningHash / consensusAt).
//!
//! Fail-safe (matches the watchtower's ethos): a candidate is DROPPED — never turned into a
//! `PendingJob` — unless the chain says it is still `PendingConsensus` AND the fetched package
//! keccak matches the orchestrator-pinned `inputHash`. So a stale/wrong indexer row, an unreachable
//! chain, or tampered package content can never drive a wrongful challenge.

use std::time::Duration;

use serde::Deserialize;

use crate::runner::{keccak_hex, JobSpec};
use crate::watchtower::{
    Challenger, JobReader, PendingJob, WatchError, WatchSource, Watchtower, PENDING_CONSENSUS,
};

/// == `Settlement.CHALLENGE_WINDOW` (1 hour). The window closes at `consensusAt + this`.
pub const CHALLENGE_WINDOW_SECS: i64 = 3600;

/// One row from `GET /v1/pending-consensus`: a redundant job that reached consensus, with the
/// package pointers needed to re-execute it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub job_id: String,
    #[allow(dead_code)]
    pub buyer: String,
    pub input_ref: String,
    pub input_hash: String,
}

#[derive(Debug, Deserialize)]
struct PendingResponse {
    jobs: Vec<Candidate>,
}

/// Lists candidate redundant jobs (the indexer endpoint). A trait so the source is testable.
pub trait CandidateSource {
    fn candidates(&mut self) -> Result<Vec<Candidate>, WatchError>;
}

/// Fetches the canonical Job Package bytes for an `inputRef`. A trait so the source is testable.
pub trait PackageFetcher {
    fn fetch(&self, input_ref: &str) -> Result<Vec<u8>, WatchError>;
}

/// Composes the candidate list + authoritative on-chain reads + package fetch into the `WatchSource`
/// the `Watchtower` consumes.
pub struct IndexerWatchSource<C, R, F> {
    candidates: C,
    reader: R,
    fetcher: F,
}

impl<C: CandidateSource, R: JobReader, F: PackageFetcher> IndexerWatchSource<C, R, F> {
    pub fn new(candidates: C, reader: R, fetcher: F) -> Self {
        Self {
            candidates,
            reader,
            fetcher,
        }
    }
}

impl<C: CandidateSource, R: JobReader, F: PackageFetcher> WatchSource
    for IndexerWatchSource<C, R, F>
{
    fn pending(&mut self) -> Result<Vec<PendingJob>, WatchError> {
        let candidates = self.candidates.candidates()?;
        let mut out = Vec::with_capacity(candidates.len());
        for c in candidates {
            // 1. Authoritative on-chain state — never act on the indexer's word alone. A read
            //    failure or any non-PendingConsensus status drops the candidate (fail-safe).
            let consensus = match self.reader.read_job(&c.job_id) {
                Ok(j) if j.status == PENDING_CONSENSUS => j,
                _ => continue,
            };
            // 2. Fetch the package and verify it is the EXACT content `inputHash` pins. A fetch
            //    error or a hash mismatch drops it (never re-execute the wrong package).
            let bytes = match self.fetcher.fetch(&c.input_ref) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if !keccak_hex(&bytes).eq_ignore_ascii_case(&c.input_hash) {
                continue;
            }
            out.push(PendingJob {
                spec: JobSpec {
                    job_id: c.job_id,
                    input_ref: c.input_ref,
                    input: bytes,
                },
                winning_hash: consensus.winning_hash,
                window_closes_at: consensus.consensus_at + CHALLENGE_WINDOW_SECS,
            });
        }
        Ok(out)
    }
}

// ---- concrete I/O impls (base deps: reqwest + the agent's fetch) ----

/// `CandidateSource` over HTTP: `GET {indexer}/v1/pending-consensus[?buyer=]`.
pub struct HttpCandidateSource {
    rt: tokio::runtime::Runtime,
    url: String,
}

impl HttpCandidateSource {
    pub fn new(indexer_base: &str, buyer: Option<&str>) -> Result<Self, WatchError> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| WatchError::Source(format!("runtime: {e}")))?;
        let mut url = format!(
            "{}/v1/pending-consensus",
            indexer_base.trim_end_matches('/')
        );
        if let Some(b) = buyer {
            url.push_str("?buyer=");
            url.push_str(b);
        }
        Ok(Self { rt, url })
    }
}

impl CandidateSource for HttpCandidateSource {
    fn candidates(&mut self) -> Result<Vec<Candidate>, WatchError> {
        let url = self.url.clone();
        self.rt.block_on(async {
            let resp = reqwest::get(&url)
                .await
                .map_err(|e| WatchError::Source(e.to_string()))?;
            if !resp.status().is_success() {
                return Err(WatchError::Source(format!(
                    "GET {url} -> {}",
                    resp.status()
                )));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| WatchError::Source(e.to_string()))?;
            let body: PendingResponse = serde_json::from_slice(&bytes)
                .map_err(|e| WatchError::Source(format!("decode: {e}")))?;
            Ok(body.jobs)
        })
    }
}

/// `PackageFetcher` backed by the agent's `fetch::fetch_input` (same fetch path the committee uses).
pub struct FetchPackageFetcher {
    rt: tokio::runtime::Runtime,
    ipfs_gateway: String,
    max_bytes: usize,
}

impl FetchPackageFetcher {
    pub fn new(ipfs_gateway: &str, max_bytes: usize) -> Result<Self, WatchError> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| WatchError::Source(format!("runtime: {e}")))?;
        Ok(Self {
            rt,
            ipfs_gateway: ipfs_gateway.to_string(),
            max_bytes,
        })
    }
}

impl PackageFetcher for FetchPackageFetcher {
    fn fetch(&self, input_ref: &str) -> Result<Vec<u8>, WatchError> {
        self.rt
            .block_on(crate::fetch::fetch_input(
                input_ref,
                &self.ipfs_gateway,
                self.max_bytes,
            ))
            .map_err(|e| WatchError::Source(format!("fetch {input_ref}: {e}")))
    }
}

/// Run the watchtower sweep loop forever (one sweep per `tick`). Runs on a plain thread — each I/O
/// component owns its own runtime + `block_on`, so this must NOT be called inside an async context.
pub fn watch_loop<S: WatchSource, C: Challenger>(mut tower: Watchtower<S, C>, tick: Duration) {
    loop {
        let now = unix_now();
        match tower.sweep(now) {
            Ok(r) => eprintln!(
                "watchtower: swept agreed={} challenged={} window_closed={} indeterminate={} challenge_errors={}",
                r.agreed, r.challenged, r.window_closed, r.indeterminate, r.challenge_errors
            ),
            Err(e) => eprintln!("watchtower: sweep error: {e}"),
        }
        std::thread::sleep(tick);
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::keccak_hex;
    use crate::watchtower::OnChainConsensus;
    use std::collections::HashMap;

    struct StaticCandidates(Vec<Candidate>);
    impl CandidateSource for StaticCandidates {
        fn candidates(&mut self) -> Result<Vec<Candidate>, WatchError> {
            Ok(self.0.clone())
        }
    }

    /// Reader returning canned on-chain state per jobId; missing jobId => read error.
    struct MapReader(HashMap<String, OnChainConsensus>);
    impl JobReader for MapReader {
        fn read_job(&self, job_id: &str) -> Result<OnChainConsensus, WatchError> {
            self.0
                .get(job_id)
                .cloned()
                .ok_or_else(|| WatchError::Source("no such job".into()))
        }
    }

    /// Fetcher returning canned bytes per inputRef; missing ref => fetch error.
    struct MapFetcher(HashMap<String, Vec<u8>>);
    impl PackageFetcher for MapFetcher {
        fn fetch(&self, input_ref: &str) -> Result<Vec<u8>, WatchError> {
            self.0
                .get(input_ref)
                .cloned()
                .ok_or_else(|| WatchError::Source("not found".into()))
        }
    }

    fn cand(job: &str, input_ref: &str, input_hash: &str) -> Candidate {
        Candidate {
            job_id: job.into(),
            buyer: "0xbuyer".into(),
            input_ref: input_ref.into(),
            input_hash: input_hash.into(),
        }
    }

    fn consensus(status: u8, winning: &str, consensus_at: i64) -> OnChainConsensus {
        OnChainConsensus {
            status,
            winning_hash: winning.into(),
            consensus_at,
        }
    }

    #[test]
    fn includes_a_pending_job_with_matching_package() {
        let pkg = b"the-package".to_vec();
        let h = keccak_hex(&pkg);
        let src = StaticCandidates(vec![cand("0xj", "ipfs://p", &h)]);
        let reader = MapReader(HashMap::from([(
            "0xj".into(),
            consensus(PENDING_CONSENSUS, "0xwin", 1000),
        )]));
        let fetcher = MapFetcher(HashMap::from([("ipfs://p".to_string(), pkg.clone())]));
        let mut s = IndexerWatchSource::new(src, reader, fetcher);

        let jobs = s.pending().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].spec.job_id, "0xj");
        assert_eq!(jobs[0].spec.input, pkg);
        assert_eq!(jobs[0].winning_hash, "0xwin");
        assert_eq!(jobs[0].window_closes_at, 1000 + CHALLENGE_WINDOW_SECS);
    }

    #[test]
    fn drops_jobs_not_pending_on_chain() {
        // status 5 = Challenged (already voided) — must be dropped (no re-exec, no challenge).
        let pkg = b"x".to_vec();
        let h = keccak_hex(&pkg);
        let src = StaticCandidates(vec![cand("0xj", "ipfs://p", &h)]);
        let reader = MapReader(HashMap::from([("0xj".into(), consensus(5, "0xwin", 1000))]));
        let fetcher = MapFetcher(HashMap::from([("ipfs://p".to_string(), pkg)]));
        let mut s = IndexerWatchSource::new(src, reader, fetcher);
        assert!(s.pending().unwrap().is_empty());
    }

    #[test]
    fn drops_jobs_whose_package_hash_mismatches_inputhash() {
        // The fetched content does NOT hash to the pinned inputHash → never re-execute it.
        let src = StaticCandidates(vec![cand("0xj", "ipfs://p", &keccak_hex(b"EXPECTED"))]);
        let reader = MapReader(HashMap::from([(
            "0xj".into(),
            consensus(PENDING_CONSENSUS, "0xwin", 1000),
        )]));
        let fetcher = MapFetcher(HashMap::from([(
            "ipfs://p".to_string(),
            b"TAMPERED".to_vec(),
        )]));
        let mut s = IndexerWatchSource::new(src, reader, fetcher);
        assert!(s.pending().unwrap().is_empty());
    }

    #[test]
    fn drops_jobs_on_chain_read_or_fetch_failure() {
        let h = keccak_hex(b"p");
        // read failure: reader has no entry for the job.
        let s1 = IndexerWatchSource::new(
            StaticCandidates(vec![cand("0xmissing", "ipfs://p", &h)]),
            MapReader(HashMap::new()),
            MapFetcher(HashMap::from([("ipfs://p".to_string(), b"p".to_vec())])),
        );
        let mut s1 = s1;
        assert!(s1.pending().unwrap().is_empty());

        // fetch failure: fetcher has no entry for the inputRef.
        let mut s2 = IndexerWatchSource::new(
            StaticCandidates(vec![cand("0xj", "ipfs://gone", &h)]),
            MapReader(HashMap::from([(
                "0xj".into(),
                consensus(PENDING_CONSENSUS, "0xwin", 1000),
            )])),
            MapFetcher(HashMap::new()),
        );
        assert!(s2.pending().unwrap().is_empty());
    }
}
