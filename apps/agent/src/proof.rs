//! Proof Engine .
//!
//! Turns a [`crate::runner::JobOutput`] into a signed [`crate::protocol::ProofBundle`]:
//! builds the EIP-712 `Proof` digest exactly as `Settlement.sol` does (domain
//! "Dawn Settlement" v1, bound to `chainId` + the Settlement address) and signs it
//! with the node wallet (secp256k1, low-s). The digest is cross-checked against the
//! contract + the TS client in CI (see `cargo run --example print_digest`).

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::protocol::ProofBundle;
use crate::runner::JobOutput;

const DOMAIN_NAME: &str = "Dawn Settlement";
const DOMAIN_VERSION: &str = "1";

#[derive(Debug)]
pub enum ProofError {
    /// A jobId/input/output hash wasn't a 0x-prefixed 32-byte hex string.
    BadHash(&'static str),
    Sign(String),
}

impl std::fmt::Display for ProofError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProofError::BadHash(field) => write!(f, "invalid bytes32 hex for {field}"),
            ProofError::Sign(msg) => write!(f, "signing error: {msg}"),
        }
    }
}

impl std::error::Error for ProofError {}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Parse a 0x-prefixed 32-byte hex string into a word.
///
/// Decodes byte-wise over `as_bytes()` with a strict `[0-9a-fA-F]` check: this avoids
/// the char-boundary panic a multibyte UTF-8 char would cause when slicing on byte
/// offsets, and rejects the `+`/whitespace that `from_str_radix` would otherwise accept.
/// `job_id` reaches here straight from a backend job assignment, so it is untrusted.
pub(crate) fn parse_b32(s: &str, field: &'static str) -> Result<[u8; 32], ProofError> {
    let hex = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    if hex.len() != 64 {
        return Err(ProofError::BadHash(field));
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = hex_nibble(hex[2 * i]).ok_or(ProofError::BadHash(field))?;
        let lo = hex_nibble(hex[2 * i + 1]).ok_or(ProofError::BadHash(field))?;
        *byte = (hi << 4) | lo;
    }
    Ok(out)
}

fn u256_word(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..32].copy_from_slice(&v.to_be_bytes());
    w
}

fn address_word(addr: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..32].copy_from_slice(addr);
    w
}

fn domain_separator(chain_id: u64, settlement: &[u8; 20]) -> [u8; 32] {
    let type_hash = keccak(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let mut enc = Vec::with_capacity(32 * 5);
    enc.extend_from_slice(&type_hash);
    enc.extend_from_slice(&keccak(DOMAIN_NAME.as_bytes()));
    enc.extend_from_slice(&keccak(DOMAIN_VERSION.as_bytes()));
    enc.extend_from_slice(&u256_word(chain_id));
    enc.extend_from_slice(&address_word(settlement));
    keccak(&enc)
}

/// The EIP-712 digest a node signs — equals `Settlement.proofDigest(proof)` on-chain.
/// `job_id`, `input_hash`, `output_hash` are 0x-prefixed bytes32 hex; `metadata` is raw bytes.
pub fn proof_digest(
    job_id: &str,
    input_hash: &str,
    output_hash: &str,
    metadata: &[u8],
    chain_id: u64,
    settlement: &[u8; 20],
) -> Result<[u8; 32], ProofError> {
    let job = parse_b32(job_id, "jobId")?;
    let inp = parse_b32(input_hash, "inputHash")?;
    let outp = parse_b32(output_hash, "outputHash")?;
    let meta_hash = keccak(metadata);

    let proof_typehash =
        keccak(b"Proof(bytes32 jobId,bytes32 inputHash,bytes32 outputHash,bytes32 metadataHash)");
    let mut struct_enc = Vec::with_capacity(32 * 5);
    struct_enc.extend_from_slice(&proof_typehash);
    struct_enc.extend_from_slice(&job);
    struct_enc.extend_from_slice(&inp);
    struct_enc.extend_from_slice(&outp);
    struct_enc.extend_from_slice(&meta_hash);
    let struct_hash = keccak(&struct_enc);

    let mut digest_input = Vec::with_capacity(2 + 32 + 32);
    digest_input.push(0x19);
    digest_input.push(0x01);
    digest_input.extend_from_slice(&domain_separator(chain_id, settlement));
    digest_input.extend_from_slice(&struct_hash);
    Ok(keccak(&digest_input))
}

/// Ethereum address of a verifying key: last 20 bytes of keccak(uncompressed pubkey without the 0x04 tag).
fn vk_address(vk: &VerifyingKey) -> [u8; 20] {
    let point = vk.to_encoded_point(false);
    let hash = keccak(&point.as_bytes()[1..]); // drop the 0x04 prefix
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..32]);
    addr
}

/// The node's on-chain operator address for this signing key.
pub fn node_address(key: &SigningKey) -> [u8; 20] {
    vk_address(key.verifying_key())
}

/// Ethereum `v` = 27 + y-parity. k256's `RecoveryId` is two bits — the high bit
/// (`is_x_reduced`, set with probability ~2^-128) can't be represented by `ecrecover`
/// and must not leak into `v`, or the contract rejects it (`v != 27 && v != 28`).
/// Masking to the parity bit matches ethers/viem/alloy. (In the vanishingly rare
/// x-reduced case the resulting signature simply won't recover and is correctly
/// rejected on-chain — never a forged signer.)
fn encode_v(recid: RecoveryId) -> u8 {
    (recid.to_byte() & 1) + 27
}

/// Sign a completed job's proof. Produces a `ProofBundle` whose `node_signature`
/// (65-byte r‖s‖v, low-s, v∈{27,28}) recovers to [`node_address`] under the contract's domain.
pub fn sign_proof(
    key: &SigningKey,
    output: &JobOutput,
    job_id: &str,
    metadata: &[u8],
    chain_id: u64,
    settlement: &[u8; 20],
) -> Result<ProofBundle, ProofError> {
    let digest = proof_digest(
        job_id,
        &output.input_hash,
        &output.output_hash,
        metadata,
        chain_id,
        settlement,
    )?;
    let (sig, recid): (Signature, RecoveryId) = key
        .sign_prehash_recoverable(&digest)
        .map_err(|e| ProofError::Sign(e.to_string()))?;

    let mut sig_bytes = [0u8; 65];
    sig_bytes[..64].copy_from_slice(&sig.to_bytes());
    sig_bytes[64] = encode_v(recid);

    Ok(ProofBundle {
        job_id: job_id.to_string(),
        input_hash: output.input_hash.clone(),
        output_hash: output.output_hash.clone(),
        metadata: to_hex(metadata),
        node_signature: to_hex(&sig_bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::keccak_hex;

    // secp256k1 half-order; the contract rejects s above this (EIP-2).
    const HALF_N: [u8; 32] = [
        0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF, 0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B,
        0x20, 0xA0,
    ];

    const SETTLEMENT: [u8; 20] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]; // 0x..01

    fn key() -> SigningKey {
        SigningKey::from_slice(&[0x11u8; 32]).unwrap()
    }

    fn sample_output() -> JobOutput {
        JobOutput {
            output: b"out".to_vec(),
            input_hash: keccak_hex(b"in"),
            output_hash: keccak_hex(b"out"),
        }
    }

    #[test]
    fn digest_is_deterministic() {
        let d1 = proof_digest(
            &keccak_hex(b"job"),
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"meta",
            8453,
            &SETTLEMENT,
        )
        .unwrap();
        let d2 = proof_digest(
            &keccak_hex(b"job"),
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"meta",
            8453,
            &SETTLEMENT,
        )
        .unwrap();
        assert_eq!(d1, d2);
    }

    #[test]
    fn digest_binds_chain_and_contract() {
        let base = proof_digest(
            &keccak_hex(b"job"),
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"meta",
            8453,
            &SETTLEMENT,
        )
        .unwrap();
        let other_chain = proof_digest(
            &keccak_hex(b"job"),
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"meta",
            84532,
            &SETTLEMENT,
        )
        .unwrap();
        let mut other_addr = SETTLEMENT;
        other_addr[19] = 2;
        let other_contract = proof_digest(
            &keccak_hex(b"job"),
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"meta",
            8453,
            &other_addr,
        )
        .unwrap();
        assert_ne!(base, other_chain);
        assert_ne!(base, other_contract);
    }

    #[test]
    fn rejects_malformed_hash() {
        let err = proof_digest(
            "0x1234",
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"m",
            8453,
            &SETTLEMENT,
        );
        assert!(matches!(err, Err(ProofError::BadHash("jobId"))));
    }

    #[test]
    fn parse_b32_rejects_multibyte_without_panicking() {
        // 64 BYTES but 63 chars (one 'é' = 2 bytes): passes the byte-length check, and a
        // naive char-offset slice would panic. Must return BadHash, not panic.
        let s = format!("{}{}{}", "a".repeat(61), "é", "a");
        assert_eq!(s.len(), 64);
        let err = proof_digest(
            &s,
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"m",
            8453,
            &SETTLEMENT,
        );
        assert!(matches!(err, Err(ProofError::BadHash("jobId"))));
    }

    #[test]
    fn parse_b32_rejects_non_canonical_plus() {
        // "+f" decodes to 0x0f via from_str_radix; strict decoding must reject it.
        let s = format!("0x+f{}", "a".repeat(62));
        let err = proof_digest(
            &s,
            &keccak_hex(b"in"),
            &keccak_hex(b"out"),
            b"m",
            8453,
            &SETTLEMENT,
        );
        assert!(matches!(err, Err(ProofError::BadHash("jobId"))));
    }

    #[test]
    fn encode_v_is_always_27_or_28() {
        for raw in 0u8..=3 {
            let v = encode_v(RecoveryId::from_byte(raw).unwrap());
            assert!(v == 27 || v == 28, "raw={raw} -> v={v}");
        }
        // x-reduced recovery ids (2,3) must not leak their high bit into v.
        assert!(RecoveryId::from_byte(2).unwrap().is_x_reduced());
        assert_eq!(encode_v(RecoveryId::from_byte(2).unwrap()), 27);
        assert_eq!(encode_v(RecoveryId::from_byte(3).unwrap()), 28);
    }

    #[test]
    fn signature_recovers_to_node_address_and_is_low_s() {
        let key = key();
        let expected = node_address(&key);
        let bundle = sign_proof(
            &key,
            &sample_output(),
            &keccak_hex(b"job"),
            b"meta",
            8453,
            &SETTLEMENT,
        )
        .unwrap();

        // decode signature
        let raw = bundle.node_signature.strip_prefix("0x").unwrap();
        let bytes: Vec<u8> = (0..raw.len() / 2)
            .map(|i| u8::from_str_radix(&raw[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        assert_eq!(bytes.len(), 65);
        let v = bytes[64];
        assert!(v == 27 || v == 28, "v must be 27/28, got {v}");

        // low-s guard (contract rejects high-s)
        let s: [u8; 32] = bytes[32..64].try_into().unwrap();
        assert!(s <= HALF_N, "signature must be low-s");

        // recover signer == node address (what the contract checks against `operator`)
        let digest = proof_digest(
            &bundle.job_id,
            &bundle.input_hash,
            &bundle.output_hash,
            b"meta",
            8453,
            &SETTLEMENT,
        )
        .unwrap();
        let sig = Signature::from_slice(&bytes[..64]).unwrap();
        let recid = RecoveryId::from_byte(v - 27).unwrap();
        let recovered = VerifyingKey::recover_from_prehash(&digest, &sig, recid).unwrap();
        assert_eq!(vk_address(&recovered), expected);
    }

    #[test]
    fn tampering_breaks_recovery() {
        let key = key();
        let expected = node_address(&key);
        let bundle = sign_proof(
            &key,
            &sample_output(),
            &keccak_hex(b"job"),
            b"meta",
            8453,
            &SETTLEMENT,
        )
        .unwrap();

        // verify against a digest for DIFFERENT output -> recovers to a different (wrong) address
        let tampered = proof_digest(
            &bundle.job_id,
            &bundle.input_hash,
            &keccak_hex(b"EVIL"),
            b"meta",
            8453,
            &SETTLEMENT,
        )
        .unwrap();
        let raw = bundle.node_signature.strip_prefix("0x").unwrap();
        let bytes: Vec<u8> = (0..65)
            .map(|i| u8::from_str_radix(&raw[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        let sig = Signature::from_slice(&bytes[..64]).unwrap();
        let recid = RecoveryId::from_byte(bytes[64] - 27).unwrap();
        let recovered = VerifyingKey::recover_from_prehash(&tampered, &sig, recid).unwrap();
        assert_ne!(vk_address(&recovered), expected);
    }
}
