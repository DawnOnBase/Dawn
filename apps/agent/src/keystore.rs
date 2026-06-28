//! Encrypted node-key keystore (M1 key custody, `ARCHITECTURE.md`).
//!
//! The node's secp256k1 private key controls real funds (it's the on-chain payee
//! and signs settle txs), and the agent runs on machines we don't control. Keeping
//! the key in a plaintext `DAWN_NODE_KEY` env var means any process that can read
//! the environment can steal it. This module keeps the key **encrypted at rest**:
//!
//! - **scrypt** stretches a passphrase into a 32-byte key (memory-hard, resists
//!   brute force), and
//! - **ChaCha20-Poly1305** (AEAD) encrypts the private key, with the operator
//!   address as additional authenticated data so a keystore can't be silently
//!   re-pointed at another address.
//!
//! The plaintext key exists only in memory while the agent runs. A later step can
//! move the *passphrase* into the OS keychain (macOS Keychain / Windows DPAPI /
//! libsecret); the on-disk format here stays the same.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce};
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};

use crate::proof::{node_address, to_hex};

// scrypt cost parameters (interactive-grade; ~16 MiB, tens of ms).
const SCRYPT_LOG_N: u8 = 15; // N = 2^15 = 32768
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const DK_LEN: usize = 32; // ChaCha20-Poly1305 key length
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12; // ChaCha20-Poly1305 nonce length

#[derive(Debug)]
pub enum KeystoreError {
    Json(String),
    Crypto(String),
    Kdf(String),
    BadKey(String),
    Random(String),
    UnsupportedVersion(u32),
    Unsupported(String),
}

impl std::fmt::Display for KeystoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeystoreError::Json(m) => write!(f, "keystore json: {m}"),
            KeystoreError::Crypto(m) => write!(f, "keystore decrypt: {m}"),
            KeystoreError::Kdf(m) => write!(f, "keystore kdf: {m}"),
            KeystoreError::BadKey(m) => write!(f, "keystore key: {m}"),
            KeystoreError::Random(m) => write!(f, "keystore rng: {m}"),
            KeystoreError::UnsupportedVersion(v) => write!(f, "unsupported keystore version {v}"),
            KeystoreError::Unsupported(m) => write!(f, "unsupported keystore: {m}"),
        }
    }
}

impl std::error::Error for KeystoreError {}

#[derive(Serialize, Deserialize)]
struct KdfParams {
    log_n: u8,
    r: u32,
    p: u32,
    dklen: usize,
    salt: String,
}

/// On-disk keystore (JSON). Mirrors the geth/web3 secret-storage shape, simplified
/// to one KDF (scrypt) and one cipher (ChaCha20-Poly1305).
#[derive(Serialize, Deserialize)]
pub struct Keystore {
    version: u32,
    /// 0x-lowercase operator address — also the AEAD additional data.
    pub address: String,
    kdf: String,
    kdfparams: KdfParams,
    cipher: String,
    nonce: String,
    ciphertext: String,
}

/// Generate a fresh random secp256k1 node key.
pub fn generate_key() -> Result<SigningKey, KeystoreError> {
    // Reject the (vanishingly rare) out-of-range scalar by resampling.
    for _ in 0..16 {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|e| KeystoreError::Random(e.to_string()))?;
        if let Ok(key) = SigningKey::from_slice(&bytes) {
            return Ok(key);
        }
    }
    Err(KeystoreError::BadKey("could not sample a valid key".into()))
}

/// Encrypt `key` under `passphrase`, returning the keystore JSON.
pub fn encrypt_key(key: &SigningKey, passphrase: &str) -> Result<String, KeystoreError> {
    let address = to_hex(&node_address(key));

    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| KeystoreError::Random(e.to_string()))?;
    getrandom::getrandom(&mut nonce).map_err(|e| KeystoreError::Random(e.to_string()))?;

    let dk = derive(passphrase, &salt, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, DK_LEN)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&dk));
    let secret = key.to_bytes();
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: secret.as_slice(),
                aad: address.as_bytes(),
            },
        )
        .map_err(|e| KeystoreError::Crypto(e.to_string()))?;

    let ks = Keystore {
        version: 1,
        address,
        kdf: "scrypt".into(),
        kdfparams: KdfParams {
            log_n: SCRYPT_LOG_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            dklen: DK_LEN,
            salt: to_hex(&salt),
        },
        cipher: "chacha20poly1305".into(),
        nonce: to_hex(&nonce),
        ciphertext: to_hex(&ciphertext),
    };
    serde_json::to_string_pretty(&ks).map_err(|e| KeystoreError::Json(e.to_string()))
}

/// Decrypt a keystore JSON with `passphrase`, returning the node signing key.
/// Fails on a wrong passphrase, a tampered file (AEAD), or an address mismatch.
pub fn decrypt_key(json: &str, passphrase: &str) -> Result<SigningKey, KeystoreError> {
    let ks: Keystore =
        serde_json::from_str(json).map_err(|e| KeystoreError::Json(e.to_string()))?;
    if ks.version != 1 {
        return Err(KeystoreError::UnsupportedVersion(ks.version));
    }
    if ks.kdf != "scrypt" {
        return Err(KeystoreError::Unsupported(format!("kdf {}", ks.kdf)));
    }
    if ks.cipher != "chacha20poly1305" {
        return Err(KeystoreError::Unsupported(format!("cipher {}", ks.cipher)));
    }

    let salt = parse_hex(&ks.kdfparams.salt)?;
    let nonce = parse_hex(&ks.nonce)?;
    let ciphertext = parse_hex(&ks.ciphertext)?;
    if nonce.len() != NONCE_LEN {
        return Err(KeystoreError::Crypto("bad nonce length".into()));
    }

    let dk = derive(
        passphrase,
        &salt,
        ks.kdfparams.log_n,
        ks.kdfparams.r,
        ks.kdfparams.p,
        ks.kdfparams.dklen,
    )?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&dk));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: ks.address.as_bytes(),
            },
        )
        .map_err(|_| KeystoreError::Crypto("wrong passphrase or corrupt keystore".into()))?;

    let key =
        SigningKey::from_slice(&plaintext).map_err(|e| KeystoreError::BadKey(e.to_string()))?;
    if to_hex(&node_address(&key)) != ks.address {
        return Err(KeystoreError::BadKey(
            "recovered key does not match address".into(),
        ));
    }
    Ok(key)
}

/// scrypt(passphrase, salt) → `dklen`-byte derived key (must be 32 for the cipher).
fn derive(
    passphrase: &str,
    salt: &[u8],
    log_n: u8,
    r: u32,
    p: u32,
    dklen: usize,
) -> Result<[u8; DK_LEN], KeystoreError> {
    if dklen != DK_LEN {
        return Err(KeystoreError::Kdf(format!("dklen {dklen} != {DK_LEN}")));
    }
    let params =
        scrypt::Params::new(log_n, r, p, dklen).map_err(|e| KeystoreError::Kdf(e.to_string()))?;
    let mut dk = [0u8; DK_LEN];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut dk)
        .map_err(|e| KeystoreError::Kdf(e.to_string()))?;
    Ok(dk)
}

/// Decode a `0x`-optional even-length hex string.
fn parse_hex(s: &str) -> Result<Vec<u8>, KeystoreError> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    if !h.len().is_multiple_of(2) {
        return Err(KeystoreError::Crypto("odd-length hex".into()));
    }
    (0..h.len() / 2)
        .map(|i| {
            u8::from_str_radix(&h[2 * i..2 * i + 2], 16)
                .map_err(|e| KeystoreError::Crypto(e.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SigningKey {
        SigningKey::from_slice(&[0x42u8; 32]).unwrap()
    }

    #[test]
    fn round_trips_with_correct_passphrase() {
        let k = key();
        let json = encrypt_key(&k, "correct horse battery staple").unwrap();
        let back = decrypt_key(&json, "correct horse battery staple").unwrap();
        assert_eq!(back.to_bytes(), k.to_bytes());
    }

    #[test]
    fn wrong_passphrase_fails() {
        let json = encrypt_key(&key(), "right").unwrap();
        assert!(matches!(
            decrypt_key(&json, "wrong"),
            Err(KeystoreError::Crypto(_))
        ));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let json = encrypt_key(&key(), "pw").unwrap();
        let mut ks: Keystore = serde_json::from_str(&json).unwrap();
        // Flip a byte of the ciphertext — AEAD must reject it.
        let mut ct = parse_hex(&ks.ciphertext).unwrap();
        ct[0] ^= 0xff;
        ks.ciphertext = to_hex(&ct);
        let tampered = serde_json::to_string(&ks).unwrap();
        assert!(decrypt_key(&tampered, "pw").is_err());
    }

    #[test]
    fn address_is_recorded_and_checked() {
        let k = key();
        let json = encrypt_key(&k, "pw").unwrap();
        let ks: Keystore = serde_json::from_str(&json).unwrap();
        assert_eq!(ks.address, to_hex(&node_address(&k)));
    }

    #[test]
    fn generate_key_produces_usable_key() {
        let k = generate_key().unwrap();
        let json = encrypt_key(&k, "pw").unwrap();
        assert_eq!(decrypt_key(&json, "pw").unwrap().to_bytes(), k.to_bytes());
    }
}
