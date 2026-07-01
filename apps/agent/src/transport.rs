//! WebSocket transport client.
//!
//! Drives the agent↔backend protocol against the job-queue coordinator
//! (`services/job-queue/internal/wsserver`). The wire shapes are the `protocol`
//! module, byte-identical to the Go/TS sides. The coordinator is strict
//! request/reply over text JSON frames on `/agent`: `hello` and `heartbeat` get
//! no reply; `pull_job` → `job_assignment`|`no_job`; `submit_result` → `ack`.
//! `pause`/`resume` exist in the protocol but the coordinator never emits them
//! today, so we handle them defensively rather than architect around server push.
//!
//! Layering: the wire I/O is the [`Transport`] seam and the agent's per-job work
//! is the [`JobHandler`] seam, so [`run_session`] (the state machine) is unit-tested
//! with mocks — no socket, no backend (mirrors `SettlementRpc`/`Sandbox`).

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::protocol::{AgentToBackend, BackendToAgent, ProofBundle};

#[derive(Debug)]
pub enum TransportError {
    /// Failed to establish the WebSocket connection.
    Connect(String),
    /// Socket read/write error, or the server closed the connection.
    Io(String),
    /// A frame couldn't be (de)serialized to a protocol message.
    Codec(String),
    /// The backend replied with a message that violates the expected sequence.
    Protocol(String),
    /// The [`JobHandler`] failed to produce a proof for an assigned job.
    Handler(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Connect(m) => write!(f, "transport connect error: {m}"),
            TransportError::Io(m) => write!(f, "transport io error: {m}"),
            TransportError::Codec(m) => write!(f, "transport codec error: {m}"),
            TransportError::Protocol(m) => write!(f, "transport protocol error: {m}"),
            TransportError::Handler(m) => write!(f, "job handler error: {m}"),
        }
    }
}

impl std::error::Error for TransportError {}

/// The wire I/O seam: send one agent message, receive one backend message.
/// Abstracted so [`run_session`] is testable without a real socket.
#[allow(async_fn_in_trait)] // single-runtime use; no Send bound needed across the seam
pub trait Transport {
    async fn send(&mut self, msg: &AgentToBackend) -> Result<(), TransportError>;
    async fn recv(&mut self) -> Result<BackendToAgent, TransportError>;
}

/// What the agent does with an assigned job: fetch the input, run it sandboxed,
/// and sign the EIP-712 proof. Returns the proof bundle + the off-chain result
/// reference to put in `submit_result`. `on_ack` is a post-ack hook (e.g. the
/// on-chain self-settle); it is best-effort and must not abort the session.
#[allow(async_fn_in_trait)]
pub trait JobHandler {
    async fn run_job(
        &self,
        job_id: &str,
        input_ref: &str,
        deadline: i64,
    ) -> Result<JobResult, TransportError>;

    async fn on_ack(&self, _job_id: &str, _proof: &ProofBundle) {}
}

/// A completed job ready to submit: the signed proof + its off-chain result ref.
pub struct JobResult {
    pub proof: ProofBundle,
    pub result_ref: String,
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// How long to wait after a `no_job` before pulling again.
    pub poll_interval: Duration,
    /// Reconnect backoff bounds (used by [`run_with_reconnect`]).
    pub reconnect_min: Duration,
    pub reconnect_max: Duration,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(5),
            reconnect_min: Duration::from_secs(1),
            reconnect_max: Duration::from_secs(30),
        }
    }
}

/// Drive one authenticated session to completion (until the connection drops or a
/// protocol violation occurs): send `hello`, then loop pulling jobs, running each
/// via the handler, submitting the proof, and awaiting the `ack`.
///
/// `hello` is built by the caller (it carries the node-wallet signature) so this
/// layer stays free of key material. Returns `Err` when the socket dies or the
/// backend breaks the sequence — the caller decides whether to reconnect.
pub async fn run_session<T: Transport, H: JobHandler, G: Fn() -> bool>(
    transport: &mut T,
    hello: &AgentToBackend,
    handler: &H,
    cfg: &SessionConfig,
    keep_going: &G,
) -> Result<(), TransportError> {
    transport.send(hello).await?;

    loop {
        // Stop pulling new work the moment the supervisor says the machine is no
        // longer idle (user returned). A clean stop, not an error.
        if !keep_going() {
            return Ok(());
        }
        transport.send(&AgentToBackend::PullJob).await?;
        match transport.recv().await? {
            BackendToAgent::JobAssignment {
                job_id,
                input_ref,
                deadline,
                ..
            } => {
                let JobResult { proof, result_ref } =
                    match handler.run_job(&job_id, &input_ref, deadline).await {
                        Ok(r) => r,
                        // A job error while we're being preempted (sandbox interrupted
                        // on user return) is an expected stop, not a failure: drop the
                        // partial result and end the session cleanly.
                        Err(e) => {
                            if !keep_going() {
                                return Ok(());
                            }
                            return Err(e);
                        }
                    };

                transport
                    .send(&AgentToBackend::SubmitResult {
                        proof: proof.clone(),
                        result_ref,
                    })
                    .await?;

                match transport.recv().await? {
                    BackendToAgent::Ack { job_id: acked } if acked == job_id => {
                        handler.on_ack(&job_id, &proof).await;
                    }
                    BackendToAgent::Ack { job_id: other } => {
                        return Err(TransportError::Protocol(format!(
                            "ack for job {other}, expected {job_id}"
                        )));
                    }
                    other => {
                        return Err(TransportError::Protocol(format!(
                            "expected ack for {job_id}, got {other:?}"
                        )));
                    }
                }
            }
            BackendToAgent::NoJob => {
                tokio::time::sleep(cfg.poll_interval).await;
            }
            // The coordinator never emits these today; respect them if it ever does.
            BackendToAgent::Pause => {
                tokio::time::sleep(cfg.poll_interval).await;
            }
            BackendToAgent::Resume => {}
            BackendToAgent::Ack { job_id } => {
                return Err(TransportError::Protocol(format!(
                    "unsolicited ack for job {job_id}"
                )));
            }
        }
    }
}

/// Real WebSocket transport over `tokio-tungstenite` (ws:// only — no TLS feature
/// is enabled yet; wss:// needs a rustls/native-tls feature).
pub struct WsTransport {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl WsTransport {
    /// Dial the coordinator, e.g. `ws://127.0.0.1:8090/agent`.
    pub async fn connect(url: &str) -> Result<Self, TransportError> {
        let (ws, _resp) = connect_async(url)
            .await
            .map_err(|e| TransportError::Connect(e.to_string()))?;
        Ok(Self { ws })
    }
}

impl Transport for WsTransport {
    async fn send(&mut self, msg: &AgentToBackend) -> Result<(), TransportError> {
        let json = serde_json::to_string(msg).map_err(|e| TransportError::Codec(e.to_string()))?;
        self.ws
            .send(Message::text(json))
            .await
            .map_err(|e| TransportError::Io(e.to_string()))
    }

    async fn recv(&mut self) -> Result<BackendToAgent, TransportError> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(txt))) => {
                    return serde_json::from_str(txt.as_str())
                        .map_err(|e| TransportError::Codec(e.to_string()));
                }
                Some(Ok(Message::Binary(bin))) => {
                    return serde_json::from_slice(&bin)
                        .map_err(|e| TransportError::Codec(e.to_string()));
                }
                // Keepalive frames are handled by the library; skip and read on.
                Some(Ok(Message::Ping(_)))
                | Some(Ok(Message::Pong(_)))
                | Some(Ok(Message::Frame(_))) => continue,
                Some(Ok(Message::Close(_))) => {
                    return Err(TransportError::Io("server closed the connection".into()))
                }
                Some(Err(e)) => return Err(TransportError::Io(e.to_string())),
                None => return Err(TransportError::Io("connection stream ended".into())),
            }
        }
    }
}

/// Connect and run sessions forever, reconnecting with exponential backoff. The
/// node wallet `hello` is rebuilt-free (reused) across reconnects. Runs until the
/// process is killed; transient connect/session errors are logged and retried.
pub async fn run_with_reconnect<H: JobHandler, G: Fn() -> bool>(
    url: &str,
    hello: &AgentToBackend,
    handler: &H,
    cfg: &SessionConfig,
    keep_going: &G,
) {
    let mut backoff = cfg.reconnect_min;
    loop {
        if !keep_going() {
            return; // supervisor asked us to stop (machine no longer idle)
        }
        match WsTransport::connect(url).await {
            Ok(mut t) => {
                backoff = cfg.reconnect_min; // reset after a good connect
                if let Err(e) = run_session(&mut t, hello, handler, cfg, keep_going).await {
                    eprintln!("dawn-agent: session ended: {e}");
                }
            }
            Err(e) => eprintln!("dawn-agent: connect {url} failed: {e}"),
        }
        if !keep_going() {
            return;
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(cfg.reconnect_max);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Scripted transport: pops queued recv results, records every send.
    #[derive(Default)]
    struct MockTransport {
        sent: Mutex<Vec<AgentToBackend>>,
        inbox: Mutex<VecDeque<Result<BackendToAgent, TransportError>>>,
    }

    impl MockTransport {
        fn with(inbox: Vec<Result<BackendToAgent, TransportError>>) -> Self {
            Self {
                sent: Mutex::new(vec![]),
                inbox: Mutex::new(inbox.into()),
            }
        }
        fn sent(&self) -> Vec<AgentToBackend> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl Transport for MockTransport {
        async fn send(&mut self, msg: &AgentToBackend) -> Result<(), TransportError> {
            self.sent.lock().unwrap().push(msg.clone());
            Ok(())
        }
        async fn recv(&mut self) -> Result<BackendToAgent, TransportError> {
            self.inbox
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(TransportError::Io("inbox drained".into())))
        }
    }

    struct MockHandler {
        runs: Mutex<Vec<String>>,
        acks: Mutex<Vec<String>>,
    }
    impl MockHandler {
        fn new() -> Self {
            Self {
                runs: Mutex::new(vec![]),
                acks: Mutex::new(vec![]),
            }
        }
    }
    impl JobHandler for MockHandler {
        async fn run_job(
            &self,
            job_id: &str,
            _input_ref: &str,
            _deadline: i64,
        ) -> Result<JobResult, TransportError> {
            self.runs.lock().unwrap().push(job_id.to_string());
            Ok(JobResult {
                proof: ProofBundle {
                    job_id: job_id.to_string(),
                    input_hash: "0x00".into(),
                    output_hash: "0xout".into(),
                    metadata: "0x".into(),
                    node_signature: "0xsig".into(),
                },
                result_ref: "ipfs://out".into(),
            })
        }
        async fn on_ack(&self, job_id: &str, _proof: &ProofBundle) {
            self.acks.lock().unwrap().push(job_id.to_string());
        }
    }

    fn hello() -> AgentToBackend {
        AgentToBackend::Hello {
            node_id: "0xnode".into(),
            sig: "0xsig".into(),
            profile: crate::protocol::NodeProfile {
                node_id: "0xnode".into(),
                gpu_tier: None,
                vram_gb: None,
                cpu_cores: 8,
                ram_gb: 32,
                region: "us-east".into(),
                reliability_score: 0.9,
            },
        }
    }

    fn cfg() -> SessionConfig {
        SessionConfig {
            poll_interval: Duration::from_millis(1),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn happy_path_hello_pull_run_submit_ack() {
        // assignment -> (run+submit) -> ack -> then socket dies to end the loop.
        let mut t = MockTransport::with(vec![
            Ok(BackendToAgent::job_assignment("j1", "ipfs://in", 9000)),
            Ok(BackendToAgent::Ack {
                job_id: "j1".into(),
            }),
            Err(TransportError::Io("closed".into())),
        ]);
        let h = MockHandler::new();

        let err = run_session(&mut t, &hello(), &h, &cfg(), &|| true)
            .await
            .unwrap_err();
        assert!(matches!(err, TransportError::Io(_)));

        // sent: hello, pull_job, submit_result, then pull_job again (which hit the closed socket)
        let sent = t.sent();
        assert!(matches!(sent[0], AgentToBackend::Hello { .. }));
        assert!(matches!(sent[1], AgentToBackend::PullJob));
        assert!(matches!(sent[2], AgentToBackend::SubmitResult { .. }));
        assert!(matches!(sent[3], AgentToBackend::PullJob));
        assert_eq!(h.runs.lock().unwrap().as_slice(), ["j1"]);
        assert_eq!(h.acks.lock().unwrap().as_slice(), ["j1"]); // on_ack fired for the matching ack
    }

    #[tokio::test]
    async fn no_job_then_retries_pull() {
        let mut t = MockTransport::with(vec![
            Ok(BackendToAgent::NoJob),
            Err(TransportError::Io("closed".into())),
        ]);
        let h = MockHandler::new();
        let _ = run_session(&mut t, &hello(), &h, &cfg(), &|| true)
            .await
            .unwrap_err();
        // hello, pull_job (-> no_job), pull_job (-> closed)
        let sent = t.sent();
        assert_eq!(sent.len(), 3);
        assert!(matches!(sent[1], AgentToBackend::PullJob));
        assert!(matches!(sent[2], AgentToBackend::PullJob));
        assert!(h.runs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn mismatched_ack_is_a_protocol_error() {
        let mut t = MockTransport::with(vec![
            Ok(BackendToAgent::job_assignment("j1", "ipfs://in", 9000)),
            Ok(BackendToAgent::Ack {
                job_id: "WRONG".into(),
            }),
        ]);
        let h = MockHandler::new();
        let err = run_session(&mut t, &hello(), &h, &cfg(), &|| true)
            .await
            .unwrap_err();
        assert!(matches!(err, TransportError::Protocol(_)));
        assert!(h.acks.lock().unwrap().is_empty()); // on_ack must NOT fire on mismatch
    }

    #[tokio::test]
    async fn unsolicited_ack_is_rejected() {
        let mut t = MockTransport::with(vec![Ok(BackendToAgent::Ack {
            job_id: "j9".into(),
        })]);
        let h = MockHandler::new();
        let err = run_session(&mut t, &hello(), &h, &cfg(), &|| true)
            .await
            .unwrap_err();
        assert!(matches!(err, TransportError::Protocol(_)));
    }

    #[tokio::test]
    async fn stops_cleanly_when_not_idle() {
        // keep_going=false (machine no longer idle): stop before pulling any job.
        let mut t = MockTransport::with(vec![]);
        let h = MockHandler::new();
        let res = run_session(&mut t, &hello(), &h, &cfg(), &|| false).await;
        assert!(res.is_ok(), "no-longer-idle is a clean stop, not an error");
        // Only `hello` went out — no pull_job.
        assert_eq!(t.sent().len(), 1);
        assert!(h.runs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn preempted_job_error_is_a_clean_stop() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        // Handler that "is interrupted" mid-job: it flips keep_going to false (as the
        // supervisor would) and returns an error, like a sandbox aborted on user return.
        struct Preempted {
            keep: Arc<AtomicBool>,
        }
        impl JobHandler for Preempted {
            async fn run_job(
                &self,
                _j: &str,
                _i: &str,
                _d: i64,
            ) -> Result<JobResult, TransportError> {
                self.keep.store(false, Ordering::SeqCst);
                Err(TransportError::Handler("sandbox interrupted".into()))
            }
        }

        let keep = Arc::new(AtomicBool::new(true));
        let mut t = MockTransport::with(vec![Ok(BackendToAgent::job_assignment("j1", "in", 0))]);
        let h = Preempted { keep: keep.clone() };
        let res = run_session(&mut t, &hello(), &h, &cfg(), &|| {
            keep.load(Ordering::SeqCst)
        })
        .await;
        assert!(
            res.is_ok(),
            "a job error while preempted is a clean stop, not Err"
        );
    }
}
