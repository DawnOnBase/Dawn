//! Integration test: the real `WsTransport` drives the real protocol against an
//! in-process WebSocket server that mimics the job-queue coordinator's
//! request/reply contract (hello → pull_job → job_assignment → submit_result →
//! ack). This exercises the actual socket + JSON serialization, not just mocks.

use std::sync::Mutex;
use std::time::Duration;

use dawn_agent::protocol::{AgentToBackend, BackendToAgent, NodeProfile, ProofBundle};
use dawn_agent::transport::{
    run_session, JobHandler, JobResult, SessionConfig, TransportError, WsTransport,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct TestHandler {
    ran: Mutex<Vec<String>>,
    acked: Mutex<Vec<String>>,
}

impl JobHandler for TestHandler {
    async fn run_job(
        &self,
        job_id: &str,
        _input_ref: &str,
        _deadline: i64,
    ) -> Result<JobResult, TransportError> {
        self.ran.lock().unwrap().push(job_id.to_string());
        Ok(JobResult {
            proof: ProofBundle {
                job_id: job_id.to_string(),
                input_hash: "0x00".into(),
                output_hash: "0xout".into(),
                metadata: "0x".into(),
                node_signature: "0xsig".into(),
            },
            result_ref: "echo://out".into(),
        })
    }
    async fn on_ack(&self, job_id: &str, _proof: &ProofBundle) {
        self.acked.lock().unwrap().push(job_id.to_string());
    }
}

fn profile() -> NodeProfile {
    NodeProfile {
        node_id: "0xnode".into(),
        gpu_tier: None,
        vram_gb: None,
        cpu_cores: 8,
        ram_gb: 32,
        region: "test".into(),
        reliability_score: 1.0,
    }
}

#[tokio::test]
async fn agent_completes_handshake_against_real_ws_server() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // Mock coordinator: hello/heartbeat → no reply; first pull_job → job_assignment,
    // later pull_job → no_job; submit_result → ack, then close the socket.
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut assigned = false;
        while let Some(Ok(msg)) = ws.next().await {
            let txt = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let m: AgentToBackend = serde_json::from_str(txt.as_str()).unwrap();
            let reply = match m {
                AgentToBackend::Hello { .. } | AgentToBackend::Heartbeat { .. } => None,
                AgentToBackend::PullJob => Some(if !assigned {
                    assigned = true;
                    BackendToAgent::job_assignment("j1", "echo://in", 9000)
                } else {
                    BackendToAgent::NoJob
                }),
                AgentToBackend::SubmitResult { proof, .. } => Some(BackendToAgent::Ack {
                    job_id: proof.job_id,
                }),
            };
            if let Some(r) = reply {
                let is_ack = matches!(r, BackendToAgent::Ack { .. });
                ws.send(Message::text(serde_json::to_string(&r).unwrap()))
                    .await
                    .unwrap();
                if is_ack {
                    let _ = ws.close(None).await; // end the session after the ack
                    break;
                }
            }
        }
    });

    let mut transport = WsTransport::connect(&format!("ws://{addr}/agent"))
        .await
        .unwrap();
    let handler = TestHandler {
        ran: Mutex::new(vec![]),
        acked: Mutex::new(vec![]),
    };
    let hello = AgentToBackend::Hello {
        node_id: "0xnode".into(),
        sig: "0xsig".into(),
        profile: profile(),
    };
    let cfg = SessionConfig {
        poll_interval: Duration::from_millis(5),
        ..Default::default()
    };

    // Ends with an error once the server closes the socket — that's the success signal.
    let res = run_session(&mut transport, &hello, &handler, &cfg, &|| true).await;
    assert!(res.is_err(), "session should end when the server closes");

    assert_eq!(
        handler.ran.lock().unwrap().as_slice(),
        ["j1"],
        "ran exactly job j1"
    );
    assert_eq!(
        handler.acked.lock().unwrap().as_slice(),
        ["j1"],
        "on_ack fired for j1"
    );
    server.await.unwrap();
}
