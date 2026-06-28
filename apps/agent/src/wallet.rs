//! Node wallet .
//!
//! Loads the node's secp256k1 key, derives its on-chain operator address (which
//! is the `nodeId`), and builds the signed `hello` that authenticates the agent
//! to the backend coordinator.
//!
//! The SAME key signs the EIP-712 job proofs (see [`crate::proof`]), so the
//! operator paid on-chain is exactly the node that authenticated. The `hello`
//! signature is an **EIP-191 personal_sign** over [`hello_auth_message`] — the
//! HELLO_AUTH scheme documented in `packages/shared/src/protocol.ts` that the backend's
//! coordinator mirrors when it replaces `AllowAllAuth` with real recovery.

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use sha3::{Digest, Keccak256};

use crate::proof::{node_address, parse_b32, to_hex};
use crate::protocol::{AgentToBackend, NodeProfile};

#[derive(Debug)]
pub enum WalletError {
    /// The key wasn't a 0x-prefixed 32-byte hex secp256k1 scalar.
    BadKey(String),
}

impl std::fmt::Display for WalletError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalletError::BadKey(m) => write!(f, "node wallet: {m}"),
        }
    }
}

impl std::error::Error for WalletError {}

/// The node's signing identity.
pub struct NodeWallet {
    key: SigningKey,
    /// 0x-lowercase operator address; doubles as the `nodeId`.
    address: String,
}

impl NodeWallet {
    /// Load from a 0x-prefixed 32-byte hex private key (e.g. the `DAWN_NODE_KEY` env var).
    pub fn from_hex(key_hex: &str) -> Result<Self, WalletError> {
        let bytes =
            parse_b32(key_hex, "nodeKey").map_err(|e| WalletError::BadKey(e.to_string()))?;
        let key = SigningKey::from_slice(&bytes).map_err(|e| WalletError::BadKey(e.to_string()))?;
        Ok(Self::from_signing_key(key))
    }

    /// Wrap an already-loaded signing key (e.g. decrypted from a keystore).
    pub fn from_signing_key(key: SigningKey) -> Self {
        let address = to_hex(&node_address(&key));
        Self { key, address }
    }

    /// Load from an encrypted keystore file, decrypting it with `passphrase`.
    /// Preferred over [`from_hex`]: the key is never a plaintext env var.
    pub fn from_keystore_file(path: &str, passphrase: &str) -> Result<Self, WalletError> {
        let json = std::fs::read_to_string(path)
            .map_err(|e| WalletError::BadKey(format!("read keystore {path}: {e}")))?;
        let key = crate::keystore::decrypt_key(&json, passphrase)
            .map_err(|e| WalletError::BadKey(e.to_string()))?;
        Ok(Self::from_signing_key(key))
    }

    /// The node key as 0x-hex. Used only to hand the key to the on-chain settle
    /// client; never written to disk or logged.
    pub fn key_hex(&self) -> String {
        to_hex(&self.key.to_bytes())
    }

    /// The node's operator address (0x-lowercase) — its `nodeId` and the on-chain payee.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// Borrow the signing key (the proof engine signs job proofs with the same key).
    pub fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    /// Build the signed `hello` message for this node.
    pub fn hello(&self, profile: NodeProfile) -> AgentToBackend {
        let sig = self.sign_message(hello_auth_message(&self.address).as_bytes());
        AgentToBackend::Hello {
            node_id: self.address.clone(),
            sig,
            profile,
        }
    }

    /// EIP-191 `personal_sign` over `msg` → `0x` + r‖s‖v (low-s, v ∈ {27,28}).
    fn sign_message(&self, msg: &[u8]) -> String {
        let (sig, recid): (Signature, RecoveryId) = self
            .key
            .sign_prehash_recoverable(&eip191_digest(msg))
            .expect("secp256k1 prehash signing is infallible for a valid key");
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig.to_bytes());
        // mask to the parity bit so v is 27/28 (matches proof::encode_v / ethers / viem).
        out[64] = (recid.to_byte() & 1) + 27;
        to_hex(&out)
    }
}

/// The canonical message a node signs to authenticate (HELLO_AUTH v1). Keep this
/// byte-identical to the coordinator's recovery side. v1 is replayable (no nonce);
/// a nonce/timestamp is required before opening to untrusted nodes (auth hardening).
pub fn hello_auth_message(node_id: &str) -> String {
    format!("Dawn agent hello\nnode: {node_id}")
}

/// keccak256 of the EIP-191 personal-sign framing of `msg`.
fn eip191_digest(msg: &[u8]) -> [u8; 32] {
    let mut framed = format!("\x19Ethereum Signed Message:\n{}", msg.len()).into_bytes();
    framed.extend_from_slice(msg);
    Keccak256::digest(&framed).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::VerifyingKey;

    fn key_hex() -> String {
        format!("0x{}", "11".repeat(32))
    }

    fn profile(node_id: &str) -> NodeProfile {
        NodeProfile {
            node_id: node_id.to_string(),
            gpu_tier: Some(3),
            vram_gb: Some(16),
            cpu_cores: 8,
            ram_gb: 32,
            region: "us-east".into(),
            reliability_score: 0.9,
        }
    }

    #[test]
    fn address_matches_proof_node_address() {
        let w = NodeWallet::from_hex(&key_hex()).unwrap();
        let expected = to_hex(&node_address(
            &SigningKey::from_slice(&[0x11u8; 32]).unwrap(),
        ));
        assert_eq!(w.address(), expected);
    }

    #[test]
    fn rejects_malformed_key() {
        assert!(matches!(
            NodeWallet::from_hex("0x1234"),
            Err(WalletError::BadKey(_))
        ));
        assert!(matches!(
            NodeWallet::from_hex("not-hex"),
            Err(WalletError::BadKey(_))
        ));
    }

    #[test]
    fn hello_carries_nodeid_and_65_byte_sig() {
        let w = NodeWallet::from_hex(&key_hex()).unwrap();
        match w.hello(profile(w.address())) {
            AgentToBackend::Hello {
                node_id,
                sig,
                profile,
            } => {
                assert_eq!(node_id, w.address());
                assert_eq!(profile.node_id, w.address());
                let raw = sig.strip_prefix("0x").unwrap();
                assert_eq!(raw.len(), 130); // 65 bytes
            }
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn hello_signature_recovers_to_node_address() {
        // What the coordinator's HELLO_AUTH verify will do: EIP-191 recover, assert == nodeId.
        let w = NodeWallet::from_hex(&key_hex()).unwrap();
        let AgentToBackend::Hello { node_id, sig, .. } = w.hello(profile(w.address())) else {
            panic!("expected Hello");
        };

        let digest = eip191_digest(hello_auth_message(&node_id).as_bytes());
        let raw = sig.strip_prefix("0x").unwrap();
        let bytes: Vec<u8> = (0..65)
            .map(|i| u8::from_str_radix(&raw[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        let signature = Signature::from_slice(&bytes[..64]).unwrap();
        let recid = RecoveryId::from_byte(bytes[64] - 27).unwrap();
        let recovered = VerifyingKey::recover_from_prehash(&digest, &signature, recid).unwrap();
        assert_eq!(to_hex(&node_address_of(&recovered)), node_id);
    }

    // Mirror of proof::vk_address for the test (last 20 bytes of keccak(pubkey)).
    fn node_address_of(vk: &VerifyingKey) -> [u8; 20] {
        let point = vk.to_encoded_point(false);
        let hash: [u8; 32] = Keccak256::digest(&point.as_bytes()[1..]).into();
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&hash[12..32]);
        addr
    }
}
