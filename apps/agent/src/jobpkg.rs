//! Canonical **Job Package** codec .
//!
//! A job's `inputRef` resolves to these bytes. The agent hashes the package whole
//! — `inputHash = keccak256(package)` — so the signed proof attests to *which
//! program ran on which data*, while the `Proof` schema stays unchanged. The
//! WASM sandbox ([`crate::runner::WasmSandbox`]) then runs `module` over `input`.
//!
//! Framing is fixed-layout little-endian so a logical package has exactly **one**
//! byte encoding — canonical in, stable hash out (which also makes the future
//! M-of-N consensus comparison meaningful). All reads are bounds-checked because
//! the package arrives from the network and is fully untrusted.

/// Magic prefix: "Dawn Job Package, format 1".
pub const MAGIC: [u8; 4] = *b"DJP1";
/// Wire format version this codec emits and accepts.
pub const VERSION: u8 = 1;

/// Per-job resource request. The agent clamps each field to its operator-set
/// ceiling ([`crate::runner::SandboxLimits`]) before running — a package can ask
/// for less than the ceiling but never more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackageLimits {
    /// wasmtime fuel budget (≈ instructions); bounds CPU deterministically.
    pub fuel: u64,
    /// Max linear-memory bytes the guest may grow to.
    pub memory_bytes: u64,
    /// Wall-clock backstop in milliseconds (epoch interruption).
    pub timeout_ms: u64,
}

/// A decoded job: the WASM `module` to run and the `input` bytes fed to its stdin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobPackage {
    pub limits: PackageLimits,
    pub module: Vec<u8>,
    pub input: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PackageError {
    /// Fewer bytes than even the fixed header needs.
    TooShort,
    /// Magic prefix didn't match — these aren't Job Package bytes.
    BadMagic,
    /// Version byte this codec doesn't understand.
    BadVersion(u8),
    /// A length field claimed more bytes than the buffer holds.
    Truncated(&'static str),
    /// Well-formed package followed by unexpected extra bytes (non-canonical).
    TrailingBytes,
}

impl std::fmt::Display for PackageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PackageError::TooShort => write!(f, "job package too short"),
            PackageError::BadMagic => write!(f, "bad job package magic (not a DJP1 package)"),
            PackageError::BadVersion(v) => write!(f, "unsupported job package version {v}"),
            PackageError::Truncated(field) => write!(f, "job package truncated reading {field}"),
            PackageError::TrailingBytes => write!(f, "job package has trailing bytes"),
        }
    }
}

impl std::error::Error for PackageError {}

/// Bounds-checked sequential reader over the untrusted package bytes.
struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize, field: &'static str) -> Result<&'a [u8], PackageError> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(PackageError::Truncated(field))?;
        if end > self.b.len() {
            return Err(PackageError::Truncated(field));
        }
        let slice = &self.b[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self, field: &'static str) -> Result<u8, PackageError> {
        Ok(self.take(1, field)?[0])
    }

    fn u64(&mut self, field: &'static str) -> Result<u64, PackageError> {
        let mut w = [0u8; 8];
        w.copy_from_slice(self.take(8, field)?);
        Ok(u64::from_le_bytes(w))
    }
}

impl JobPackage {
    /// Serialize to the canonical wire form.
    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(4 + 2 + 24 + 8 + self.module.len() + 8 + self.input.len());
        b.extend_from_slice(&MAGIC);
        b.push(VERSION);
        b.push(0); // flags (reserved, must be 0)
        b.extend_from_slice(&self.limits.fuel.to_le_bytes());
        b.extend_from_slice(&self.limits.memory_bytes.to_le_bytes());
        b.extend_from_slice(&self.limits.timeout_ms.to_le_bytes());
        b.extend_from_slice(&(self.module.len() as u64).to_le_bytes());
        b.extend_from_slice(&self.module);
        b.extend_from_slice(&(self.input.len() as u64).to_le_bytes());
        b.extend_from_slice(&self.input);
        b
    }

    /// Parse from untrusted bytes, rejecting truncation, bad magic/version, and
    /// trailing bytes (which would make the encoding non-canonical).
    pub fn decode(bytes: &[u8]) -> Result<Self, PackageError> {
        // magic(4) + ver(1) + flags(1) + fuel(8) + mem(8) + timeout(8) + 2×len(8)
        if bytes.len() < 4 + 1 + 1 + 8 * 3 + 8 * 2 {
            return Err(PackageError::TooShort);
        }
        let mut r = Reader { b: bytes, pos: 0 };
        if r.take(4, "magic")? != MAGIC {
            return Err(PackageError::BadMagic);
        }
        let version = r.u8("version")?;
        if version != VERSION {
            return Err(PackageError::BadVersion(version));
        }
        let _flags = r.u8("flags")?;
        let fuel = r.u64("fuel")?;
        let memory_bytes = r.u64("memory_bytes")?;
        let timeout_ms = r.u64("timeout_ms")?;

        let module_len = r.u64("module_len")? as usize;
        let module = r.take(module_len, "module")?.to_vec();
        let input_len = r.u64("input_len")? as usize;
        let input = r.take(input_len, "input")?.to_vec();

        if r.pos != bytes.len() {
            return Err(PackageError::TrailingBytes);
        }
        Ok(JobPackage {
            limits: PackageLimits {
                fuel,
                memory_bytes,
                timeout_ms,
            },
            module,
            input,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> JobPackage {
        JobPackage {
            limits: PackageLimits {
                fuel: 5_000_000,
                memory_bytes: 64 * 1024 * 1024,
                timeout_ms: 10_000,
            },
            module: b"\0asm\x01\0\0\0".to_vec(), // minimal wasm header bytes
            input: b"hello".to_vec(),
        }
    }

    #[test]
    fn round_trips() {
        let pkg = sample();
        let decoded = JobPackage::decode(&pkg.encode()).unwrap();
        assert_eq!(pkg, decoded);
    }

    #[test]
    fn encoding_is_canonical() {
        // Same logical package → identical bytes (so inputHash is stable).
        assert_eq!(sample().encode(), sample().encode());
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = sample().encode();
        bytes[0] = b'X';
        assert_eq!(JobPackage::decode(&bytes), Err(PackageError::BadMagic));
    }

    #[test]
    fn rejects_bad_version() {
        let mut bytes = sample().encode();
        bytes[4] = 9;
        assert_eq!(JobPackage::decode(&bytes), Err(PackageError::BadVersion(9)));
    }

    #[test]
    fn rejects_too_short() {
        assert_eq!(
            JobPackage::decode(b"DJP1").unwrap_err(),
            PackageError::TooShort
        );
    }

    #[test]
    fn rejects_truncated_module() {
        // Header claims a 1 MiB module but the buffer ends right after the length.
        let mut bytes = sample().encode();
        // Corrupt module_len (the u64 at offset 4+1+1+24 = 30) to a huge value.
        let off = 4 + 1 + 1 + 24;
        bytes[off..off + 8].copy_from_slice(&(1u64 << 20).to_le_bytes());
        assert!(matches!(
            JobPackage::decode(&bytes),
            Err(PackageError::Truncated(_))
        ));
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut bytes = sample().encode();
        bytes.push(0xff);
        assert_eq!(JobPackage::decode(&bytes), Err(PackageError::TrailingBytes));
    }
}
