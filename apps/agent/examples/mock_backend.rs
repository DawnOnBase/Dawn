//! Dev-only mock coordinator for the live agent demo. Stands in for the backend's
//! job-queue matcher: accepts the agent's `hello`, hands it ONE job (from env),
//! and `ack`s the submitted proof. Run it alongside `dawn-agent` and an escrowed
//! job to prove the agent leg end-to-end against the live Settlement contract.
//!
//! ```text
//! DAWN_MOCK_JOBID=0x<bytes32> \
//! DAWN_MOCK_INPUTREF=https://example.com/input \
//! cargo run --example mock_backend
//! ```
//! Not part of the shipped agent — it exists only to drive the demo until the backend's
//! backend (api + job-queue + indexer + Postgres) is stood up.

use dawn_agent::protocol::{AgentToBackend, BackendToAgent};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8090".into());
    let job_id = std::env::var("DAWN_MOCK_JOBID")
        .expect("set DAWN_MOCK_JOBID (0x bytes32 = the escrowed jobId)");
    // Any public URL works — the sandbox just hashes the bytes. Default to a tiny,
    // always-public page so the demo doesn't depend on repo visibility.
    let input_ref =
        std::env::var("DAWN_MOCK_INPUTREF").unwrap_or_else(|_| "https://example.com".into());
    let deadline: i64 = std::env::var("DAWN_MOCK_DEADLINE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4_102_444_800); // year 2100

    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).await.expect("bind");
    println!("mock-backend: ws://{addr}/agent — will assign job {job_id} (input {input_ref})");

    loop {
        let (stream, peer) = listener.accept().await.expect("accept");
        let (job_id, input_ref) = (job_id.clone(), input_ref.clone());
        tokio::spawn(async move {
            let mut ws = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    eprintln!("mock-backend: handshake {peer}: {e}");
                    return;
                }
            };
            println!("mock-backend: agent connected ({peer})");
            let mut assigned = false;
            while let Some(Ok(msg)) = ws.next().await {
                let txt = match msg {
                    Message::Text(t) => t,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let m: AgentToBackend = match serde_json::from_str(txt.as_str()) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("mock-backend: bad message: {e}");
                        continue;
                    }
                };
                let reply = match m {
                    AgentToBackend::Hello { node_id, .. } => {
                        println!("mock-backend: hello from {node_id}");
                        None
                    }
                    AgentToBackend::Heartbeat { .. } => None,
                    AgentToBackend::PullJob => Some(if !assigned {
                        assigned = true;
                        println!("mock-backend: assigning {job_id}");
                        BackendToAgent::job_assignment(job_id.clone(), input_ref.clone(), deadline)
                    } else {
                        BackendToAgent::NoJob
                    }),
                    AgentToBackend::SubmitResult { proof, result_ref } => {
                        println!(
                            "mock-backend: proof for {} (resultRef {result_ref}) — acking",
                            proof.job_id
                        );
                        Some(BackendToAgent::Ack {
                            job_id: proof.job_id,
                        })
                    }
                };
                if let Some(r) = reply {
                    if ws
                        .send(Message::text(serde_json::to_string(&r).unwrap()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            println!("mock-backend: agent disconnected ({peer})");
        });
    }
}
