//! Durable proof outbox (M2 reliability).
//!
//! A node that finishes a job has done real work and is owed payment. If the socket
//! drops or the agent crashes between running the job and settling its proof
//! on-chain, that payment must not be lost. The outbox persists every completed
//! proof the moment it is produced; the (idempotent) settle worker drains it —
//! promptly via the settle channel on the happy path, and by re-scanning the outbox
//! on boot and on a periodic timer to recover anything stranded. An entry is removed
//! only once its proof has settled on-chain (or is found terminally unpayable).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::protocol::ProofBundle;

/// A completed job awaiting settlement: the signed proof + its off-chain result ref.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxEntry {
    pub job_id: String,
    pub proof: ProofBundle,
    pub result_ref: String,
}

/// File-backed at-least-once outbox keyed by jobId. Cheap to share (`Arc`): the
/// handler adds entries and the settle worker removes them.
pub struct FileOutbox {
    path: PathBuf,
    entries: Mutex<HashMap<String, OutboxEntry>>,
}

impl FileOutbox {
    /// Load persisted entries from `path` (missing/unreadable ⇒ empty).
    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, OutboxEntry>>(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            entries: Mutex::new(entries),
        }
    }

    /// Persist a completed proof (idempotent on jobId; last write wins).
    pub fn add(&self, job_id: &str, proof: &ProofBundle, result_ref: &str) {
        let mut e = self.entries.lock().unwrap();
        e.insert(
            job_id.to_string(),
            OutboxEntry {
                job_id: job_id.to_string(),
                proof: proof.clone(),
                result_ref: result_ref.to_string(),
            },
        );
        self.persist(&e);
    }

    /// Drop an entry once its proof has settled (or is terminally unpayable).
    pub fn remove(&self, job_id: &str) {
        let mut e = self.entries.lock().unwrap();
        if e.remove(job_id).is_some() {
            self.persist(&e);
        }
    }

    /// Snapshot of all pending entries.
    pub fn pending(&self) -> Vec<OutboxEntry> {
        self.entries.lock().unwrap().values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn persist(&self, entries: &HashMap<String, OutboxEntry>) {
        if let Err(e) = atomic_write_json(&self.path, entries) {
            eprintln!(
                "outbox: WARNING could not persist {}: {e}",
                self.path.display()
            );
        }
    }
}

/// Atomic JSON write: serialize to a sibling `.tmp`, fsync, rename over the target.
fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
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

    fn proof(id: &str) -> ProofBundle {
        ProofBundle {
            job_id: id.into(),
            input_hash: "0x00".into(),
            output_hash: "0x01".into(),
            metadata: "0x".into(),
            node_signature: "0x".into(),
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("dawn-outbox-test-{name}.json"));
        std::fs::remove_file(&p).ok();
        p
    }

    #[test]
    fn add_pending_remove() {
        let ob = FileOutbox::load(tmp("ar"));
        ob.add("j1", &proof("j1"), "ref1");
        assert_eq!(ob.len(), 1);
        assert_eq!(ob.pending()[0].result_ref, "ref1");
        ob.remove("j1");
        assert!(ob.is_empty());
    }

    #[test]
    fn survives_reload() {
        let path = tmp("reload");
        {
            let ob = FileOutbox::load(&path);
            ob.add("j", &proof("j"), "r");
        }
        // A fresh process loads the stranded proof for recovery.
        let ob2 = FileOutbox::load(&path);
        assert_eq!(ob2.len(), 1);
        assert_eq!(ob2.pending()[0].job_id, "j");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn add_is_idempotent_on_job_id() {
        let ob = FileOutbox::load(tmp("idem"));
        ob.add("j", &proof("j"), "r1");
        ob.add("j", &proof("j"), "r2");
        assert_eq!(ob.len(), 1);
        assert_eq!(ob.pending()[0].result_ref, "r2"); // last write wins
    }
}
