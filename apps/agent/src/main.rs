//! Dawn agent entrypoint .
//!
//! Wires the full agent loop: load config → unlock the node wallet → gate on idle
//! → connect to the backend coordinator over WebSocket → for each assigned job,
//! fetch its input, run it sandboxed, sign the EIP-712 proof, submit it, and (with
//! `--features onchain`) self-settle on-chain after the ack.
//!
//! The on-chain settle is synchronous (`OnchainSettlement` owns a blocking runtime),
//! so it runs on a dedicated worker thread fed by a channel — keeping the async
//! transport loop free of nested-runtime hazards.

use dawn_agent::config::AgentConfig;
use dawn_agent::fetch;
use dawn_agent::idle::{self, Decision, IdleConfig};
use dawn_agent::probes::{self, ProbeConfig};
use dawn_agent::proof;
use dawn_agent::protocol::{NodeProfile, ProofBundle};
use dawn_agent::runner::{execute, JobSpec, Sandbox};
use dawn_agent::transport::{self, JobHandler, JobResult, SessionConfig, TransportError};
use dawn_agent::wallet::NodeWallet;
use k256::ecdsa::SigningKey;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How often the idle supervisor re-checks whether the machine is still idle.
const SUPERVISE_POLL: Duration = Duration::from_secs(3);

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Subcommands: `keystore` manages the encrypted node key; `pack` builds a Job
    // Package from a WASM module + input. Everything else runs the agent.
    let sub = args.get(1).map(String::as_str);
    if let Some(cmd @ ("keystore" | "pack")) = sub {
        let result = match cmd {
            "keystore" => keystore_cmd(&args[2..]),
            _ => pack_cmd(&args[2..]),
        };
        if let Err(e) = result {
            eprintln!("dawn-agent {cmd}: {e}");
            std::process::exit(1);
        }
        return;
    }
    if sub == Some("watchtower") {
        watchtower_cmd();
        return;
    }
    if let Err(e) = run().await {
        eprintln!("dawn-agent: fatal: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = AgentConfig::from_env()?;
    let wallet = load_wallet(&cfg)?;
    let operator = wallet.address().to_string();
    let settlement =
        parse_addr(&cfg.settlement).ok_or("DAWN_SETTLEMENT is not a 20-byte 0x address")?;

    println!(
        "dawn-agent: node {operator}\n            backend {}\n            settlement {} (chain {})",
        cfg.backend_ws, cfg.settlement, cfg.chain_id
    );

    // Durable proof outbox (Some only when self-settling). Shared by the handler
    // (adds completed proofs) and the settle worker (settles + clears them).
    let outbox = build_outbox(&cfg);

    // On-chain self-settle worker (feature-gated). on_ack hands proofs to it. The
    // settle client needs the raw key, derived from the unlocked wallet (never disk).
    let node_key_hex = wallet.key_hex();
    let settle_tx = settle_sender(&cfg, &operator, &node_key_hex, outbox.clone());

    // The real job sandbox (wasmtime). Built once; shared across jobs and the idle
    // watcher, which interrupts an in-flight job when the user returns.
    let sandbox = build_sandbox(&cfg)?;
    let sandbox_watch = sandbox.clone();

    let handler = AgentJobHandler {
        key: wallet.signing_key().clone(),
        chain_id: cfg.chain_id,
        settlement,
        ipfs_gateway: cfg.ipfs_gateway.clone(),
        max_input_bytes: cfg.max_input_bytes,
        settle_tx,
        sandbox,
        outbox,
    };

    let profile = NodeProfile {
        node_id: operator.clone(),
        gpu_tier: None,
        vram_gb: None,
        cpu_cores: 8,
        ram_gb: 32,
        region: cfg.region.clone(),
        reliability_score: 1.0,
    };
    let hello = wallet.hello(profile);
    let session = SessionConfig::default();

    // DAWN_FORCE_RUN: skip idle supervision entirely (CI / headless / triggered runs),
    // honouring only the explicit pause control that lives inside the probes.
    if std::env::var_os("DAWN_FORCE_RUN").is_some() {
        println!(
            "dawn-agent: DAWN_FORCE_RUN set — idle supervision off; connecting to {} …",
            cfg.backend_ws
        );
        transport::run_with_reconnect(&cfg.backend_ws, &hello, &handler, &session, &|| true).await;
        return Ok(());
    }

    // Continuous idle supervision: accept jobs only while the machine is genuinely
    // idle, and preempt the in-flight job the instant the user returns.
    let idle_cfg = IdleConfig::default();
    println!(
        "dawn-agent: idle supervision on (idle threshold {}s); waiting for idle …",
        idle_cfg.idle_threshold_secs
    );
    loop {
        wait_until_idle(&idle_cfg).await;
        println!("dawn-agent: machine idle — accepting jobs");

        // `keep` is held true while idle; the watcher flips it false (and interrupts
        // any running job) on the first sign the user is back.
        let keep = Arc::new(AtomicBool::new(true));
        let watcher = spawn_idle_watcher(keep.clone(), sandbox_watch.clone(), idle_cfg.clone());

        let keep_fn = {
            let keep = keep.clone();
            move || keep.load(Ordering::SeqCst)
        };
        transport::run_with_reconnect(&cfg.backend_ws, &hello, &handler, &session, &keep_fn).await;

        let _ = watcher.join();
        println!("dawn-agent: user active — paused; waiting for idle again");
    }
}

/// Sample the live idle decision (real OS probes + the idle policy). Honours DAWN_PAUSED.
fn current_decision(idle_cfg: &IdleConfig) -> Decision {
    let paused = std::env::var_os("DAWN_PAUSED").is_some();
    let signals = probes::sample(&ProbeConfig {
        paused,
        blackout: false,
    });
    idle::evaluate(idle_cfg, &signals)
}

/// Wait until the machine is idle, sampling off the async runtime (the probe shells
/// out on some platforms) every [`SUPERVISE_POLL`].
async fn wait_until_idle(idle_cfg: &IdleConfig) {
    loop {
        let cfg = idle_cfg.clone();
        let decision = tokio::task::spawn_blocking(move || current_decision(&cfg))
            .await
            .unwrap_or(Decision::Active("probe task failed"));
        if decision == Decision::Idle {
            return;
        }
        tokio::time::sleep(SUPERVISE_POLL).await;
    }
}

/// Background thread that watches for the user's return; on the first Active reading
/// it stops the session (`keep` → false) and interrupts any in-flight sandbox job.
fn spawn_idle_watcher(
    keep: Arc<AtomicBool>,
    sandbox: Arc<dyn Sandbox>,
    idle_cfg: IdleConfig,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || loop {
        std::thread::sleep(SUPERVISE_POLL);
        if !keep.load(Ordering::SeqCst) {
            return; // session already ended for another reason
        }
        if let Decision::Active(reason) = current_decision(&idle_cfg) {
            println!("dawn-agent: user active ({reason}) — preempting in-flight job");
            keep.store(false, Ordering::SeqCst);
            sandbox.interrupt();
            return;
        }
    })
}

/// The agent's per-job work: fetch input → run sandboxed → sign the proof; and the
/// post-ack hook that triggers the on-chain self-settle.
struct AgentJobHandler {
    key: SigningKey,
    chain_id: u64,
    settlement: [u8; 20],
    ipfs_gateway: String,
    max_input_bytes: usize,
    settle_tx: Option<std::sync::mpsc::Sender<ProofBundle>>,
    sandbox: Arc<dyn Sandbox>,
    /// Durable queue of completed proofs (Some when self-settling); the settle
    /// worker drains it so a finished job still gets paid after a socket drop/crash.
    outbox: Option<Arc<dawn_agent::outbox::FileOutbox>>,
}

impl JobHandler for AgentJobHandler {
    async fn run_job(
        &self,
        job_id: &str,
        input_ref: &str,
        _deadline: i64,
    ) -> Result<JobResult, TransportError> {
        let input = fetch::fetch_input(input_ref, &self.ipfs_gateway, self.max_input_bytes)
            .await
            .map_err(|e| TransportError::Handler(e.to_string()))?;

        let spec = JobSpec {
            job_id: job_id.to_string(),
            input_ref: input_ref.to_string(),
            input,
        };
        // WASM execution blocks; run it off the async transport loop so heartbeats
        // and the rest of the session stay responsive.
        let sandbox = self.sandbox.clone();
        let output = tokio::task::spawn_blocking(move || execute(&*sandbox, &spec))
            .await
            .map_err(|e| TransportError::Handler(format!("sandbox task join: {e}")))?
            .map_err(|e| TransportError::Handler(e.to_string()))?;

        // metadata stays empty (non-binding telemetry lands here in a later milestone).
        let proof = proof::sign_proof(
            &self.key,
            &output,
            job_id,
            b"",
            self.chain_id,
            &self.settlement,
        )
        .map_err(|e| TransportError::Handler(e.to_string()))?;

        println!(
            "dawn-agent: ran job {job_id} — outputHash {}",
            output.output_hash
        );
        let result_ref = format!("dawn-output://{}", output.output_hash);
        // Durably queue the proof BEFORE it leaves: if the socket drops or we crash
        // before it settles, the settle worker recovers it from here.
        if let Some(outbox) = &self.outbox {
            outbox.add(job_id, &proof, &result_ref);
        }
        Ok(JobResult { proof, result_ref })
    }

    async fn on_ack(&self, job_id: &str, proof: &ProofBundle) {
        match &self.settle_tx {
            Some(tx) => {
                if tx.send(proof.clone()).is_err() {
                    eprintln!("dawn-agent: settle worker stopped; cannot settle {job_id}");
                }
            }
            None => println!(
                "dawn-agent: job {job_id} acked (build with --features onchain to self-settle)"
            ),
        }
    }
}

/// Spawn the settle worker (with `--features onchain`) and return its sender, or
/// `None` when on-chain support isn't compiled in.
#[cfg(feature = "onchain")]
fn settle_sender(
    cfg: &AgentConfig,
    operator: &str,
    node_key_hex: &str,
    outbox: Option<Arc<dawn_agent::outbox::FileOutbox>>,
) -> Option<std::sync::mpsc::Sender<ProofBundle>> {
    use dawn_agent::onchain::OnchainSettlement;
    use dawn_agent::payout::PayoutManager;
    use std::sync::mpsc::RecvTimeoutError;

    let outbox = outbox.expect("onchain run always builds an outbox");
    let (tx, rx) = std::sync::mpsc::channel::<ProofBundle>();
    let (rpc_url, settlement, node_key, operator, payout_store) = (
        cfg.rpc_url.clone(),
        cfg.settlement.clone(),
        node_key_hex.to_string(),
        operator.to_string(),
        cfg.payout_store.clone(),
    );

    std::thread::spawn(move || {
        let mut rpc = match OnchainSettlement::new(&rpc_url, &settlement, &node_key) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("dawn-agent: on-chain client init failed: {e}");
                return;
            }
        };
        // Durable payout state survives restarts; reconcile against the chain on boot
        // so a crash between an on-chain settle and the local record self-heals.
        let mut payout = PayoutManager::with_store(operator, &payout_store);
        payout.reconcile(&mut rpc);
        // Recover any proofs left un-settled by a prior crash/socket drop.
        if !outbox.is_empty() {
            println!(
                "dawn-agent: recovering {} queued proof(s) from the outbox",
                outbox.len()
            );
            drain_outbox(&mut payout, &mut rpc, &outbox);
        }
        // Settle proofs as they arrive; on idle, periodically re-drive the outbox to
        // recover anything stranded mid-session (socket dropped before the settle).
        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(30)) {
                Ok(proof) => settle_and_clear(&mut payout, &mut rpc, &outbox, &proof),
                Err(RecvTimeoutError::Timeout) => drain_outbox(&mut payout, &mut rpc, &outbox),
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Some(tx)
}

/// Settle one proof and clear it from the outbox on success — or if the job is
/// terminally unpayable on-chain, so a stuck entry can't grow the queue forever.
#[cfg(feature = "onchain")]
fn settle_and_clear<R: dawn_agent::payout::SettlementRpc>(
    payout: &mut dawn_agent::payout::PayoutManager,
    rpc: &mut R,
    outbox: &dawn_agent::outbox::FileOutbox,
    proof: &ProofBundle,
) {
    use dawn_agent::payout::OnchainStatus;
    match payout.submit(rpc, proof) {
        Ok(()) => {
            let paid = payout.claim_settled(rpc);
            println!(
                "dawn-agent: settled {} — operator paid {} USDC base units (total {})",
                proof.job_id,
                paid,
                payout.total_claimed()
            );
            outbox.remove(&proof.job_id);
        }
        Err(e) => {
            eprintln!("dawn-agent: settle failed for {}: {e}", proof.job_id);
            if matches!(
                rpc.job_status(&proof.job_id),
                Ok(OnchainStatus::None) | Ok(OnchainStatus::Refunded)
            ) {
                eprintln!("dawn-agent: abandoning unpayable job {}", proof.job_id);
                outbox.remove(&proof.job_id);
            }
        }
    }
}

/// Re-drive every queued proof through settlement (idempotent).
#[cfg(feature = "onchain")]
fn drain_outbox<R: dawn_agent::payout::SettlementRpc>(
    payout: &mut dawn_agent::payout::PayoutManager,
    rpc: &mut R,
    outbox: &dawn_agent::outbox::FileOutbox,
) {
    for entry in outbox.pending() {
        settle_and_clear(payout, rpc, outbox, &entry.proof);
    }
}

#[cfg(not(feature = "onchain"))]
fn settle_sender(
    _cfg: &AgentConfig,
    _operator: &str,
    _node_key_hex: &str,
    _outbox: Option<Arc<dawn_agent::outbox::FileOutbox>>,
) -> Option<std::sync::mpsc::Sender<ProofBundle>> {
    None
}

// ===================== M9 watchtower (S2) — buyer's-keeper mode =====================

/// `dawn-agent watchtower` — run the buyer's-keeper watchtower (M9 #7). Polls the indexer for
/// its buyer's PendingConsensus jobs, re-executes each under the same D1 runtime the committee used,
/// and `challenge()`s a wrong consensus before the window closes. Requires `--features onchain,wasm`.
#[cfg(all(feature = "onchain", feature = "wasm"))]
fn watchtower_cmd() {
    // The I/O components (chain reads/writes, indexer HTTP, package fetch) each own their own tokio
    // runtime + block_on, which must NOT run inside main's async runtime — so drive the (sync) sweep
    // loop on a dedicated OS thread.
    let handle = std::thread::spawn(|| {
        if let Err(e) = run_watchtower() {
            eprintln!("dawn-agent watchtower: {e}");
            std::process::exit(1);
        }
    });
    let _ = handle.join();
}

#[cfg(not(all(feature = "onchain", feature = "wasm")))]
fn watchtower_cmd() {
    eprintln!("dawn-agent: the watchtower requires building with --features onchain,wasm");
    std::process::exit(1);
}

#[cfg(all(feature = "onchain", feature = "wasm"))]
fn run_watchtower() -> Result<(), Box<dyn std::error::Error>> {
    use dawn_agent::onchain::OnchainSettlement;
    use dawn_agent::watchsource::{
        watch_loop, FetchPackageFetcher, HttpCandidateSource, IndexerWatchSource,
    };
    use dawn_agent::watchtower::Watchtower;
    use std::time::Duration;

    const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024; // cap on a fetched Job Package
    const TICK_SECS: u64 = 30; // sweep cadence (well within the 1h challenge window)

    let cfg = AgentConfig::from_env()?;
    let buyer_key = std::env::var("DAWN_WATCHTOWER_KEY").map_err(|_| {
        "DAWN_WATCHTOWER_KEY (the buyer's signing key — challenge() is buyer-only) is required"
    })?;
    let indexer_url =
        std::env::var("DAWN_INDEXER_URL").unwrap_or_else(|_| "http://127.0.0.1:8083".into());
    let buyer = std::env::var("DAWN_BUYER").ok(); // optional: scope to this buyer's jobs

    // Reader + challenger both sign with the buyer's key (the read is a view call; the challenge
    // must come from msg.sender == buyer). Same D1 sandbox build the committee used.
    let reader = OnchainSettlement::new(&cfg.rpc_url, &cfg.settlement, &buyer_key)?;
    let challenger = OnchainSettlement::new(&cfg.rpc_url, &cfg.settlement, &buyer_key)?;
    let candidates = HttpCandidateSource::new(&indexer_url, buyer.as_deref())?;
    let fetcher = FetchPackageFetcher::new(&cfg.ipfs_gateway, MAX_PACKAGE_BYTES)?;
    let source = IndexerWatchSource::new(candidates, reader, fetcher);
    let sandbox = build_sandbox(&cfg)?;

    println!(
        "dawn-agent watchtower (buyer-keeper): rpc {} settlement {} indexer {} buyer {}",
        cfg.rpc_url,
        cfg.settlement,
        indexer_url,
        buyer.as_deref().unwrap_or("<all>")
    );
    watch_loop(
        Watchtower::new(source, challenger, sandbox),
        Duration::from_secs(TICK_SECS),
    );
    Ok(())
}

/// Build the durable proof outbox — Some only when self-settling (`onchain`), since
/// without on-chain settle there is nothing to queue.
#[cfg(feature = "onchain")]
fn build_outbox(cfg: &AgentConfig) -> Option<Arc<dawn_agent::outbox::FileOutbox>> {
    Some(Arc::new(dawn_agent::outbox::FileOutbox::load(
        &cfg.outbox_path,
    )))
}

#[cfg(not(feature = "onchain"))]
fn build_outbox(_cfg: &AgentConfig) -> Option<Arc<dawn_agent::outbox::FileOutbox>> {
    None
}

/// Unlock the node wallet from config: an encrypted keystore (preferred) or the
/// plaintext `DAWN_NODE_KEY` fallback (dev/headless), which warns loudly.
fn load_wallet(cfg: &AgentConfig) -> Result<NodeWallet, Box<dyn std::error::Error>> {
    if let Some(path) = &cfg.keystore_path {
        let pass = cfg
            .keystore_pass
            .as_deref()
            .ok_or("DAWN_KEYSTORE is set but DAWN_KEYSTORE_PASS is not")?;
        let wallet = NodeWallet::from_keystore_file(path, pass)?;
        println!("dawn-agent: unlocked keystore {path}");
        Ok(wallet)
    } else if let Some(hex) = &cfg.node_key {
        eprintln!(
            "dawn-agent: WARNING — using DAWN_NODE_KEY (plaintext key in env). Prefer an \
             encrypted keystore: `dawn-agent keystore import <file>`"
        );
        Ok(NodeWallet::from_hex(hex)?)
    } else {
        Err("no key source (set DAWN_KEYSTORE or DAWN_NODE_KEY)".into())
    }
}

/// `dawn-agent keystore <new|import|address> <file>` — manage the encrypted node key.
/// Passphrase comes from `DAWN_KEYSTORE_PASS`; `import` reads the key from `DAWN_NODE_KEY`.
fn keystore_cmd(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use dawn_agent::keystore;
    let pass = || -> Result<String, Box<dyn std::error::Error>> {
        std::env::var("DAWN_KEYSTORE_PASS")
            .map_err(|_| "set DAWN_KEYSTORE_PASS to the keystore passphrase".into())
    };
    match args.first().map(String::as_str).unwrap_or("") {
        "new" => {
            let out = args.get(1).ok_or("usage: dawn-agent keystore new <file>")?;
            let key = keystore::generate_key()?;
            let json = keystore::encrypt_key(&key, &pass()?)?;
            write_new(out, json.as_bytes())?;
            println!(
                "created keystore {out}\n  address {}",
                NodeWallet::from_signing_key(key).address()
            );
            Ok(())
        }
        "import" => {
            let out = args
                .get(1)
                .ok_or("usage: dawn-agent keystore import <file>  (key from DAWN_NODE_KEY)")?;
            let hex = std::env::var("DAWN_NODE_KEY")
                .map_err(|_| "set DAWN_NODE_KEY to the 0x private key to import")?;
            let wallet = NodeWallet::from_hex(&hex)?;
            let json = keystore::encrypt_key(wallet.signing_key(), &pass()?)?;
            write_new(out, json.as_bytes())?;
            println!("imported keystore {out}\n  address {}", wallet.address());
            Ok(())
        }
        "address" => {
            let path = args
                .get(1)
                .ok_or("usage: dawn-agent keystore address <file>")?;
            let wallet = NodeWallet::from_keystore_file(path, &pass()?)?;
            println!("{}", wallet.address());
            Ok(())
        }
        _ => Err("usage: dawn-agent keystore <new|import|address> <file>".into()),
    }
}

/// `dawn-agent pack <module.wasm|.wat> <out.djp> [input-file]` — build a canonical
/// Job Package (D1) a buyer escrows and a node runs. The module is validated as
/// real WASM; the package's `inputHash` (what the proof binds) is printed.
fn pack_cmd(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let usage = "usage: dawn-agent pack <module.wasm|.wat> <out.djp> [input-file]";
    let module_path = args.first().ok_or(usage)?;
    let out = args.get(1).ok_or(usage)?;
    let module =
        std::fs::read(module_path).map_err(|e| format!("read module {module_path}: {e}"))?;
    let input = match args.get(2) {
        Some(p) => std::fs::read(p).map_err(|e| format!("read input {p}: {e}"))?,
        None => Vec::new(),
    };

    // Reject a non-module file early (only possible with the wasm runtime compiled in).
    #[cfg(feature = "wasm")]
    dawn_agent::runner::validate_wasm(&module)?;

    let pkg = dawn_agent::jobpkg::JobPackage {
        limits: dawn_agent::jobpkg::PackageLimits {
            fuel: 1_000_000_000,
            memory_bytes: 256 * 1024 * 1024,
            timeout_ms: 30_000,
        },
        module,
        input,
    }
    .encode();
    let input_hash = dawn_agent::runner::keccak_hex(&pkg);
    write_new(out, &pkg)?;
    println!(
        "packed {out}\n  bytes      {}\n  inputHash  {}",
        pkg.len(),
        input_hash
    );
    Ok(())
}

/// Write a new file, refusing to clobber an existing one, with 0600 perms on unix
/// (the keystore is sensitive even though it's encrypted).
fn write_new(path: &str, contents: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("cannot create {path} (already exists?): {e}"))?;
    f.write_all(contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Build the job sandbox. With the default `wasm` feature this is the real
/// `wasmtime` sandbox; without it, a loud EchoSandbox that runs nothing (dev only).
#[cfg(feature = "wasm")]
fn build_sandbox(cfg: &AgentConfig) -> Result<Arc<dyn Sandbox>, Box<dyn std::error::Error>> {
    let sb = dawn_agent::runner::WasmSandbox::new(cfg.sandbox)?;
    println!(
        "dawn-agent: sandbox = wasmtime (fuel {}, mem {} MiB, timeout {} ms)",
        cfg.sandbox.fuel,
        cfg.sandbox.memory_bytes / (1024 * 1024),
        cfg.sandbox.timeout_ms
    );
    Ok(Arc::new(sb))
}

#[cfg(not(feature = "wasm"))]
fn build_sandbox(_cfg: &AgentConfig) -> Result<Arc<dyn Sandbox>, Box<dyn std::error::Error>> {
    eprintln!(
        "dawn-agent: WARNING — built without the `wasm` feature; EchoSandbox runs NOTHING (dev only)"
    );
    Ok(Arc::new(dawn_agent::runner::EchoSandbox))
}

/// Parse a 0x-prefixed 20-byte address into bytes (byte-wise; no char-boundary panic).
fn parse_addr(s: &str) -> Option<[u8; 20]> {
    let hex = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    if hex.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = (hex[2 * i] as char).to_digit(16)?;
        let lo = (hex[2 * i + 1] as char).to_digit(16)?;
        *byte = ((hi << 4) | lo) as u8;
    }
    Some(out)
}
