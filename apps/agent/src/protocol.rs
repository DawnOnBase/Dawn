//! Rust mirror of the shared agent↔backend protocol
//! (packages/shared/src/protocol.ts, the architecture). TypeScript is the source
//! of truth — keep the `t` tags and field names identical. Transport: WebSocket
//! JSON; auth = node-wallet signature on `hello`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeProfile {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "gpuTier")]
    pub gpu_tier: Option<i64>,
    #[serde(rename = "vramGb")]
    pub vram_gb: Option<i64>,
    #[serde(rename = "cpuCores")]
    pub cpu_cores: i64,
    #[serde(rename = "ramGb")]
    pub ram_gb: i64,
    pub region: String,
    #[serde(rename = "reliabilityScore")]
    pub reliability_score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProofBundle {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "inputHash")]
    pub input_hash: String,
    #[serde(rename = "outputHash")]
    pub output_hash: String,
    pub metadata: String,
    #[serde(rename = "nodeSignature")]
    pub node_signature: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum AgentToBackend {
    #[serde(rename = "hello")]
    Hello {
        #[serde(rename = "nodeId")]
        node_id: String,
        sig: String,
        profile: NodeProfile,
    },
    #[serde(rename = "pull_job")]
    PullJob,
    #[serde(rename = "heartbeat")]
    Heartbeat { ts: i64 },
    #[serde(rename = "submit_result")]
    SubmitResult {
        proof: ProofBundle,
        #[serde(rename = "resultRef")]
        result_ref: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum BackendToAgent {
    #[serde(rename = "job_assignment")]
    JobAssignment {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "inputRef")]
        input_ref: String,
        deadline: i64,
        // --- M9 redundant fields (the redundant-execution design). Present ONLY for an M-of-N
        // committee member; a single-node assignment omits them, so they default to None/empty and
        // the single-node decode is unchanged. The agent submits its proof with `merkle_proof`
        // against `operator_set_root`; `assignment_sig` is the orchestrator authorization. ---
        #[serde(
            rename = "operatorSetRoot",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        operator_set_root: Option<String>,
        #[serde(
            rename = "assignmentSig",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        assignment_sig: Option<String>,
        #[serde(rename = "merkleProof", default, skip_serializing_if = "Vec::is_empty")]
        merkle_proof: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redundancy: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nonce: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bond: Option<String>,
    },
    #[serde(rename = "no_job")]
    NoJob,
    #[serde(rename = "ack")]
    Ack {
        #[serde(rename = "jobId")]
        job_id: String,
    },
    #[serde(rename = "pause")]
    Pause,
    #[serde(rename = "resume")]
    Resume,
}

impl BackendToAgent {
    /// Build a single-node `job_assignment` (no redundant committee fields). Keeps construction
    /// sites terse now that the variant carries six optional M9 fields.
    pub fn job_assignment(
        job_id: impl Into<String>,
        input_ref: impl Into<String>,
        deadline: i64,
    ) -> Self {
        BackendToAgent::JobAssignment {
            job_id: job_id.into(),
            input_ref: input_ref.into(),
            deadline,
            operator_set_root: None,
            assignment_sig: None,
            merkle_proof: Vec::new(),
            redundancy: None,
            nonce: None,
            bond: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_serializes_with_t_tag_and_camelcase() {
        let msg = AgentToBackend::Hello {
            node_id: "0xnode".into(),
            sig: "0xsig".into(),
            profile: NodeProfile {
                node_id: "0xnode".into(),
                gpu_tier: Some(3),
                vram_gb: Some(16),
                cpu_cores: 8,
                ram_gb: 32,
                region: "us-east".into(),
                reliability_score: 0.9,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"t\":\"hello\""));
        assert!(json.contains("\"nodeId\":\"0xnode\""));
        assert!(json.contains("\"reliabilityScore\":0.9"));
    }

    #[test]
    fn pull_job_round_trips() {
        let msg = AgentToBackend::PullJob;
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, "{\"t\":\"pull_job\"}");
        let back: AgentToBackend = serde_json::from_str(&json).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn decodes_backend_job_assignment() {
        let json =
            r#"{"t":"job_assignment","jobId":"0xj1","inputRef":"ipfs://in","deadline":9000}"#;
        let msg: BackendToAgent = serde_json::from_str(json).unwrap();
        match msg {
            BackendToAgent::JobAssignment {
                job_id,
                input_ref,
                deadline,
                ..
            } => {
                assert_eq!(job_id, "0xj1");
                assert_eq!(input_ref, "ipfs://in");
                assert_eq!(deadline, 9000);
            }
            _ => panic!("expected job_assignment"),
        }
    }

    #[test]
    fn decodes_redundant_job_assignment() {
        // A redundant job_assignment carries the orchestrator authorization + the member's proof.
        let json = r#"{"t":"job_assignment","jobId":"0xr1","inputRef":"ipfs://in","deadline":9000,
            "operatorSetRoot":"0xroot","assignmentSig":"0xsig","merkleProof":["0xa","0xb"],
            "redundancy":3,"nonce":7,"bond":"10000000"}"#;
        let msg: BackendToAgent = serde_json::from_str(json).unwrap();
        match msg {
            BackendToAgent::JobAssignment {
                operator_set_root,
                assignment_sig,
                merkle_proof,
                redundancy,
                nonce,
                bond,
                ..
            } => {
                assert_eq!(operator_set_root.as_deref(), Some("0xroot"));
                assert_eq!(assignment_sig.as_deref(), Some("0xsig"));
                assert_eq!(merkle_proof, vec!["0xa", "0xb"]);
                assert_eq!(redundancy, Some(3));
                assert_eq!(nonce, Some(7));
                assert_eq!(bond.as_deref(), Some("10000000"));
            }
            _ => panic!("expected job_assignment"),
        }
    }

    #[test]
    fn single_node_job_assignment_omits_redundant_fields() {
        // The single-node constructor must serialize WITHOUT any redundant keys (wire shape frozen).
        let msg = BackendToAgent::job_assignment("0xj1", "ipfs://in", 9000);
        let json = serde_json::to_string(&msg).unwrap();
        assert!(!json.contains("operatorSetRoot"));
        assert!(!json.contains("merkleProof"));
        assert!(!json.contains("redundancy"));
    }

    #[test]
    fn decodes_no_job() {
        let msg: BackendToAgent = serde_json::from_str(r#"{"t":"no_job"}"#).unwrap();
        assert_eq!(msg, BackendToAgent::NoJob);
    }
}
