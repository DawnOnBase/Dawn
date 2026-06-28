//! Sandboxed job runner . Executes a job inside a sandbox and
//! produces the output plus the keccak256 input/output hashes the Proof Engine
//! (, the agent) signs into a `ProofBundle` ( hashing scheme).
//!
//! The `Sandbox` trait is the isolation boundary. The runtime is **WebAssembly via
//! `wasmtime`** (a design decision, `ARCHITECTURE.md`): a job's `inputRef`
//! resolves to a canonical [`crate::jobpkg::JobPackage`] (a WASM `module` + its
//! `input`), and [`WasmSandbox`] runs it with NO host FS/network, fuel + epoch
//! (timeout) + memory limits, destroying the instance after each job. `EchoSandbox`
//! remains a dev/test placeholder that runs nothing real.

use sha3::{Digest, Keccak256};
use std::fmt;

#[derive(Debug, Clone)]
pub struct JobSpec {
    pub job_id: String,
    pub input_ref: String,
    /// The fetched `inputRef` bytes. For real jobs these are a canonical
    /// [`crate::jobpkg::JobPackage`]; `inputHash = keccak256(input)` binds them.
    pub input: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct JobOutput {
    pub output: Vec<u8>,
    pub input_hash: String,
    pub output_hash: String,
}

#[derive(Debug)]
pub enum RunError {
    Sandbox(String),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Sandbox(msg) => write!(f, "sandbox error: {msg}"),
        }
    }
}

impl std::error::Error for RunError {}

/// Operator-set resource ceilings for the sandbox. Each job's
/// [`crate::jobpkg::PackageLimits`] request is clamped to these — a job may ask
/// for less, never more, so a hostile package can't exhaust the host machine.
#[derive(Debug, Clone, Copy)]
pub struct SandboxLimits {
    /// Max wasmtime fuel (≈ instruction budget) per job.
    pub fuel: u64,
    /// Max linear-memory bytes a job's guest may grow to.
    pub memory_bytes: usize,
    /// Wall-clock backstop per job, in milliseconds.
    pub timeout_ms: u64,
    /// Max bytes captured from the guest's stdout.
    pub max_output_bytes: usize,
}

impl Default for SandboxLimits {
    fn default() -> Self {
        Self {
            fuel: 10_000_000_000,
            memory_bytes: 256 * 1024 * 1024,
            timeout_ms: 30_000,
            max_output_bytes: 32 * 1024 * 1024,
        }
    }
}

/// The isolation boundary. `Send + Sync` so the runner can execute jobs on a
/// blocking worker thread off the async transport loop.
pub trait Sandbox: Send + Sync {
    /// Execute the job in isolation and return its raw output bytes.
    fn run(&self, spec: &JobSpec) -> Result<Vec<u8>, RunError>;

    /// Abort an in-flight [`run`] (best-effort, callable from another thread).
    /// Default: no-op. The WASM sandbox bumps the wasmtime epoch so the running
    /// guest traps — used to preempt a job the instant the machine's user returns.
    fn interrupt(&self) {}
}

/// keccak256 of `bytes` as a 0x-prefixed lowercase hex string.
pub fn keccak_hex(bytes: &[u8]) -> String {
    let digest = Keccak256::digest(bytes);
    let mut s = String::with_capacity(2 + digest.len() * 2);
    s.push_str("0x");
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Run a job and hash its input/output for the proof bundle. `?Sized` so a
/// `&dyn Sandbox` trait object (the production wiring) works as well as a concrete type.
pub fn execute<S: Sandbox + ?Sized>(sandbox: &S, spec: &JobSpec) -> Result<JobOutput, RunError> {
    let output = sandbox.run(spec)?;
    Ok(JobOutput {
        input_hash: keccak_hex(&spec.input),
        output_hash: keccak_hex(&output),
        output,
    })
}

/// Dev/test sandbox: returns the input unchanged. Runs no real workload — only
/// for builds made with `--no-default-features` (the `wasm` feature off).
pub struct EchoSandbox;

impl Sandbox for EchoSandbox {
    fn run(&self, spec: &JobSpec) -> Result<Vec<u8>, RunError> {
        Ok(spec.input.clone())
    }
}

/// The real job sandbox: runs the [`crate::jobpkg::JobPackage`]'s WASM module over
/// its input with `wasmtime`. Isolation contract (M0 D2): the guest gets stdin +
/// stdout pipes and nothing else — no preopened dirs, no env/args, no sockets, so
/// the host filesystem and network are unreachable. CPU is bounded by fuel, wall
/// time by an epoch watchdog, and memory by a per-store limiter. The instance is
/// dropped (sandbox destroyed) when `run` returns.
#[cfg(feature = "wasm")]
pub struct WasmSandbox {
    engine: wasmtime::Engine,
    ceilings: SandboxLimits,
}

#[cfg(feature = "wasm")]
struct WasmHost {
    wasi: wasmtime_wasi::p1::WasiP1Ctx,
    limits: wasmtime::StoreLimits,
}

#[cfg(feature = "wasm")]
impl WasmSandbox {
    pub fn new(ceilings: SandboxLimits) -> Result<Self, RunError> {
        let mut cfg = wasmtime::Config::new();
        cfg.consume_fuel(true); // deterministic CPU budget
        cfg.epoch_interruption(true); // wall-clock timeout backstop
        let engine =
            wasmtime::Engine::new(&cfg).map_err(|e| RunError::Sandbox(format!("engine: {e}")))?;
        Ok(Self { engine, ceilings })
    }
}

#[cfg(feature = "wasm")]
impl Sandbox for WasmSandbox {
    fn run(&self, spec: &JobSpec) -> Result<Vec<u8>, RunError> {
        use wasmtime::{Linker, Module, Store, StoreLimitsBuilder};
        use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
        use wasmtime_wasi::WasiCtxBuilder;

        let pkg = crate::jobpkg::JobPackage::decode(&spec.input)
            .map_err(|e| RunError::Sandbox(format!("job package: {e}")))?;

        // Clamp every requested limit to the operator ceiling (never above it).
        let fuel = pkg.limits.fuel.min(self.ceilings.fuel).max(1);
        let mem = (pkg.limits.memory_bytes as usize).min(self.ceilings.memory_bytes);
        let timeout_ms = pkg.limits.timeout_ms.min(self.ceilings.timeout_ms).max(1);
        let out_cap = self.ceilings.max_output_bytes;

        let module = Module::new(&self.engine, &pkg.module)
            .map_err(|e| RunError::Sandbox(format!("module compile: {e}")))?;

        // The guest's ONLY I/O: stdin = the job input, stdout = captured output.
        // No preopens / env / args / sockets ⇒ host FS + network are unreachable.
        let stdout = MemoryOutputPipe::new(out_cap);
        let wasi = WasiCtxBuilder::new()
            .stdin(MemoryInputPipe::new(pkg.input))
            .stdout(stdout.clone())
            .build_p1();

        let limits = StoreLimitsBuilder::new()
            .memory_size(mem)
            .memories(1)
            .tables(1)
            .instances(1)
            .build();

        let mut store = Store::new(&self.engine, WasmHost { wasi, limits });
        store.limiter(|h| &mut h.limits);
        store
            .set_fuel(fuel)
            .map_err(|e| RunError::Sandbox(format!("set fuel: {e}")))?;
        store.set_epoch_deadline(1);

        // Watchdog: bump the engine epoch after the timeout to trap a stuck guest,
        // unless the job signals completion first by dropping `done_tx`.
        let engine = self.engine.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if done_rx
                .recv_timeout(std::time::Duration::from_millis(timeout_ms))
                .is_err()
            {
                engine.increment_epoch();
            }
        });

        let mut linker: Linker<WasmHost> = Linker::new(&self.engine);
        let run_result =
            wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |h: &mut WasmHost| &mut h.wasi)
                .and_then(|()| {
                    let instance = linker.instantiate(&mut store, &module)?;
                    let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
                    start.call(&mut store, ())
                });

        let _ = done_tx.send(()); // release the watchdog
        let _ = watchdog.join();

        if let Err(e) = run_result {
            // A WASI command ends by calling `proc_exit`; exit(0) is a clean finish.
            match e.downcast_ref::<wasmtime_wasi::I32Exit>() {
                Some(exit) if exit.0 == 0 => {}
                Some(exit) => {
                    return Err(RunError::Sandbox(format!(
                        "guest exited with code {}",
                        exit.0
                    )))
                }
                None => return Err(RunError::Sandbox(format!("execution failed: {e}"))),
            }
        }

        Ok(stdout.contents().to_vec())
    }

    fn interrupt(&self) {
        // Bump the engine epoch; any guest currently running on this engine traps
        // at its next epoch check (the run loop reports it as an execution error).
        self.engine.increment_epoch();
    }
}

/// Compile-check that `module_bytes` is a valid WASM (or WAT) module, without
/// running it. Used by the `pack` tool to reject a non-module file early.
#[cfg(feature = "wasm")]
pub fn validate_wasm(module_bytes: &[u8]) -> Result<(), RunError> {
    let engine = wasmtime::Engine::default();
    wasmtime::Module::new(&engine, module_bytes)
        .map(|_| ())
        .map_err(|e| RunError::Sandbox(format!("invalid wasm module: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_hex_empty_matches_known_vector() {
        // keccak256("") — the canonical empty-input digest.
        assert_eq!(
            keccak_hex(b""),
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    #[test]
    fn execute_hashes_input_and_output() {
        let spec = JobSpec {
            job_id: "0xj1".into(),
            input_ref: "ipfs://in".into(),
            input: b"hello".to_vec(),
        };
        let out = execute(&EchoSandbox, &spec).unwrap();
        assert_eq!(out.output, b"hello");
        // Echo => input and output hash to the same value.
        assert_eq!(out.input_hash, out.output_hash);
        assert_eq!(out.input_hash, keccak_hex(b"hello"));
    }

    struct FailingSandbox;
    impl Sandbox for FailingSandbox {
        fn run(&self, _spec: &JobSpec) -> Result<Vec<u8>, RunError> {
            Err(RunError::Sandbox("boom".into()))
        }
    }

    #[test]
    fn surfaces_sandbox_errors() {
        let spec = JobSpec {
            job_id: "j".into(),
            input_ref: "r".into(),
            input: vec![],
        };
        assert!(execute(&FailingSandbox, &spec).is_err());
    }

    // The real sandbox tests compile WASM via wasmtime — only under the `wasm` feature.
    #[cfg(feature = "wasm")]
    mod wasm {
        use super::*;
        use crate::jobpkg::{JobPackage, PackageLimits};

        fn pkg(module_wat: &str, input: &[u8], fuel: u64, mem: u64) -> Vec<u8> {
            JobPackage {
                limits: PackageLimits {
                    fuel,
                    memory_bytes: mem,
                    timeout_ms: 5_000,
                },
                module: module_wat.as_bytes().to_vec(), // wasmtime parses WAT text
                input: input.to_vec(),
            }
            .encode()
        }

        fn spec(input: Vec<u8>) -> JobSpec {
            JobSpec {
                job_id: "0xj".into(),
                input_ref: "inline".into(),
                input,
            }
        }

        // Writes the constant "hello" to stdout (fd 1) via WASI fd_write.
        const HELLO_WAT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "hello")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 100)) ;; iov.base
    (i32.store (i32.const 4) (i32.const 5))   ;; iov.len
    (drop (call $fd_write
      (i32.const 1)   ;; fd = stdout
      (i32.const 0)   ;; iovs
      (i32.const 1)   ;; iovs_len
      (i32.const 20)) ;; nwritten out
    )))
"#;

        #[test]
        fn runs_a_real_module_and_captures_stdout() {
            let sb = WasmSandbox::new(SandboxLimits::default()).unwrap();
            let out = execute(&sb, &spec(pkg(HELLO_WAT, b"", 1_000_000, 4 * 1024 * 1024))).unwrap();
            assert_eq!(out.output, b"hello");
            assert_eq!(out.output_hash, keccak_hex(b"hello"));
        }

        #[test]
        fn fuel_limit_traps_runaway_guest() {
            // Infinite loop — must be killed by the (clamped-low) fuel budget.
            let spin = r#"(module (func (export "_start") (loop (br 0))))"#;
            let ceilings = SandboxLimits {
                fuel: 100_000,
                ..SandboxLimits::default()
            };
            let sb = WasmSandbox::new(ceilings).unwrap();
            let err = execute(&sb, &spec(pkg(spin, b"", u64::MAX, 1024 * 1024)));
            assert!(err.is_err(), "runaway guest should trap on fuel exhaustion");
        }

        #[test]
        fn rejects_non_package_input() {
            let sb = WasmSandbox::new(SandboxLimits::default()).unwrap();
            let err = execute(&sb, &spec(b"not a job package".to_vec()));
            assert!(err.is_err());
        }
    }
}
