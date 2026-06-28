//! M4 smoke: prove the real WASM sandbox runs a non-echo, **input-dependent**
//! workload through the agent's actual job path (package → execute → hash → sign).
//!
//! The workload sums stdin bytes mod 256 and writes the one-byte result — a genuine
//! computation whose output depends on the input, so it exercises far more than the
//! old EchoSandbox. Runs only with the default `wasm` feature.
#![cfg(feature = "wasm")]

use dawn_agent::jobpkg::{JobPackage, PackageLimits};
use dawn_agent::proof::sign_proof;
use dawn_agent::runner::{execute, keccak_hex, JobSpec, SandboxLimits, WasmSandbox};
use dawn_agent::wallet::NodeWallet;
use k256::ecdsa::SigningKey;

/// A real WASI workload: read stdin, sum the bytes, write `(sum & 0xff)` as one byte.
const SUM_WAT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 2)
  (func (export "_start")
    (local $nread i32) (local $i i32) (local $sum i32)
    ;; read stdin into [64..), iovec{base,len} at [0], nread at [8]
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 4096))
    (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
    (local.set $nread (i32.load (i32.const 8)))
    ;; sum the bytes
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $nread)))
        (local.set $sum
          (i32.add (local.get $sum)
            (i32.load8_u (i32.add (local.get $i) (i32.const 64)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    ;; write one byte: sum & 0xff, from [16], iovec at [0]
    (i32.store8 (i32.const 16) (i32.and (local.get $sum) (i32.const 0xff)))
    (i32.store (i32.const 0) (i32.const 16))
    (i32.store (i32.const 4) (i32.const 1))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))
"#;

fn package(input: &[u8]) -> Vec<u8> {
    JobPackage {
        limits: PackageLimits {
            fuel: 50_000_000,
            memory_bytes: 8 * 1024 * 1024,
            timeout_ms: 5_000,
        },
        module: SUM_WAT.as_bytes().to_vec(),
        input: input.to_vec(),
    }
    .encode()
}

#[test]
fn real_workload_runs_and_proof_binds_it() {
    let input = b"hello"; // 104+101+108+108+111 = 532; 532 & 0xff = 20
    let pkg = package(input);

    let sandbox = WasmSandbox::new(SandboxLimits::default()).unwrap();
    let spec = JobSpec {
        job_id: format!("0x{}", "11".repeat(32)),
        input_ref: "inline".into(),
        input: pkg.clone(),
    };
    let out = execute(&sandbox, &spec).unwrap();

    // The sandbox did real, input-dependent compute (NOT echo).
    assert_eq!(out.output, vec![20u8], "sum of b\"hello\" mod 256");
    assert_ne!(
        out.output.as_slice(),
        pkg.as_slice(),
        "must not echo its input"
    );

    // Hashing matches the scheme: inputHash binds the whole package.
    assert_eq!(out.input_hash, keccak_hex(&pkg));
    assert_eq!(out.output_hash, keccak_hex(&[20u8]));

    // The proof signs over the real output and recovers to the node operator.
    let key = SigningKey::from_slice(&[0x33u8; 32]).unwrap();
    let wallet = NodeWallet::from_signing_key(key.clone());
    let settlement = [0u8; 20];
    let proof = sign_proof(&key, &out, &spec.job_id, b"", 84532, &settlement).unwrap();
    assert_eq!(proof.output_hash, out.output_hash);
    assert_eq!(proof.input_hash, out.input_hash);
    assert_eq!(proof.node_signature.strip_prefix("0x").unwrap().len(), 130); // 65 bytes
                                                                             // The operator address (payee) is the node wallet's address.
    assert!(wallet.address().starts_with("0x"));
}

#[test]
fn output_changes_with_input() {
    let sandbox = WasmSandbox::new(SandboxLimits::default()).unwrap();
    let run = |inp: &[u8]| {
        let spec = JobSpec {
            job_id: format!("0x{}", "22".repeat(32)),
            input_ref: "inline".into(),
            input: package(inp),
        };
        execute(&sandbox, &spec).unwrap().output
    };
    // Different inputs → different proven outputs (the proof actually means something).
    assert_eq!(run(b"\x01\x02\x03"), vec![6u8]);
    assert_eq!(run(b"\xff\xff"), vec![254u8]); // 510 & 0xff
    assert_ne!(run(b"abc"), run(b"xyz"));
}
