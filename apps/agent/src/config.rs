//! Agent runtime configuration, loaded from the environment.
//!
//! Centralizes the values that must agree with the deployed contract — chiefly
//! `DAWN_CHAIN_ID` (84532 / Base Sepolia) and `DAWN_SETTLEMENT`. A wrong chainId
//! makes the EIP-712 proof digest differ and `settle` reverts `BAD_PROOF`, so this
//! is the single place that pins them.

#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// 0x-hex secp256k1 node key — DEV/headless fallback (`DAWN_NODE_KEY`). Prefer
    /// `keystore_path`; a plaintext key in the environment is a theft risk.
    pub node_key: Option<String>,
    /// Path to an encrypted keystore file (`DAWN_KEYSTORE`) — the preferred key source.
    pub keystore_path: Option<String>,
    /// Passphrase for the keystore (`DAWN_KEYSTORE_PASS`; later: OS keychain).
    pub keystore_pass: Option<String>,
    /// Coordinator WebSocket URL, e.g. `ws://127.0.0.1:8090/agent`.
    pub backend_ws: String,
    /// Base Sepolia RPC URL for on-chain settle.
    pub rpc_url: String,
    /// Deployed Settlement address.
    pub settlement: String,
    /// EIP-712 chainId — MUST match the deployed contract (84532 for Base Sepolia).
    pub chain_id: u64,
    /// Region tag advertised in the node profile.
    pub region: String,
    /// IPFS gateway for `ipfs://` input refs.
    pub ipfs_gateway: String,
    /// Max input blob size accepted from `inputRef`.
    pub max_input_bytes: usize,
    /// Operator-set resource ceilings the sandbox clamps each job to.
    pub sandbox: crate::runner::SandboxLimits,
    /// File where the Payout Manager persists durable earnings/job state so
    /// accounting survives a crash/restart (`DAWN_PAYOUT_STORE`).
    pub payout_store: String,
    /// File where completed-but-unsettled proofs are durably queued so payment
    /// survives a socket drop / crash before settle (`DAWN_OUTBOX`).
    pub outbox_path: String,
}

#[derive(Debug)]
pub enum ConfigError {
    Missing(&'static str),
    Bad(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Missing(k) => write!(f, "config: required env var {k} is not set"),
            ConfigError::Bad(m) => write!(f, "config: {m}"),
        }
    }
}

impl std::error::Error for ConfigError {}

impl AgentConfig {
    /// Load from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Load from an arbitrary lookup (keeps `from_env` testable without touching
    /// the process-global environment).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let req = |k: &'static str| {
            get(k)
                .filter(|v| !v.is_empty())
                .ok_or(ConfigError::Missing(k))
        };
        let opt = |k: &str, def: &str| {
            get(k)
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| def.to_string())
        };

        let chain_id = opt("DAWN_CHAIN_ID", "84532")
            .parse::<u64>()
            .map_err(|e| ConfigError::Bad(format!("DAWN_CHAIN_ID: {e}")))?;
        let max_input_bytes = opt("DAWN_MAX_INPUT_BYTES", "33554432") // 32 MiB
            .parse::<usize>()
            .map_err(|e| ConfigError::Bad(format!("DAWN_MAX_INPUT_BYTES: {e}")))?;

        // Sandbox ceilings the operator is willing to lend the job (jobs may request
        // less, never more). Defaults match `runner::SandboxLimits::default`.
        let num = |k: &'static str, def: &str| -> Result<u64, ConfigError> {
            opt(k, def)
                .parse::<u64>()
                .map_err(|e| ConfigError::Bad(format!("{k}: {e}")))
        };
        let sandbox = crate::runner::SandboxLimits {
            fuel: num("DAWN_MAX_FUEL", "10000000000")?,
            memory_bytes: num("DAWN_MAX_MEMORY_MB", "256")? as usize * 1024 * 1024,
            timeout_ms: num("DAWN_MAX_TIMEOUT_MS", "30000")?,
            max_output_bytes: num("DAWN_MAX_OUTPUT_BYTES", "33554432")? as usize,
        };

        // Key source: prefer an encrypted keystore; fall back to a plaintext env key
        // (dev/headless). At least one must be present.
        let keystore_path = get("DAWN_KEYSTORE").filter(|v| !v.is_empty());
        let keystore_pass = get("DAWN_KEYSTORE_PASS").filter(|v| !v.is_empty());
        let node_key = get("DAWN_NODE_KEY").filter(|v| !v.is_empty());
        if keystore_path.is_none() && node_key.is_none() {
            return Err(ConfigError::Missing("DAWN_KEYSTORE or DAWN_NODE_KEY"));
        }
        let settlement = req("DAWN_SETTLEMENT")?;

        // A state file: explicit env path, else next to the keystore, else cwd.
        let state_file = |env_key: &str, default_name: &str| -> String {
            get(env_key)
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| match &keystore_path {
                    Some(ks) => std::path::Path::new(ks)
                        .parent()
                        .filter(|d| !d.as_os_str().is_empty())
                        .map(|d| d.join(default_name).to_string_lossy().into_owned())
                        .unwrap_or_else(|| default_name.to_string()),
                    None => default_name.to_string(),
                })
        };
        let payout_store = state_file("DAWN_PAYOUT_STORE", "dawn-payout.json");
        let outbox_path = state_file("DAWN_OUTBOX", "dawn-outbox.json");

        Ok(Self {
            node_key,
            keystore_path,
            keystore_pass,
            backend_ws: opt("DAWN_BACKEND_WS", "ws://127.0.0.1:8090/agent"),
            rpc_url: opt("DAWN_RPC_URL", "https://sepolia.base.org"),
            settlement,
            chain_id,
            region: opt("DAWN_REGION", "unknown"),
            ipfs_gateway: opt("DAWN_IPFS_GATEWAY", crate::fetch::DEFAULT_IPFS_GATEWAY),
            max_input_bytes,
            sandbox,
            payout_store,
            outbox_path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn map(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn loads_with_defaults() {
        let cfg = AgentConfig::from_lookup(map(&[
            ("DAWN_NODE_KEY", "0xabc"),
            (
                "DAWN_SETTLEMENT",
                "0xc27C681cE93a63C0987226CDaC7b66232018651E",
            ),
        ]))
        .unwrap();
        assert_eq!(cfg.chain_id, 84532); // Base Sepolia default
        assert_eq!(cfg.backend_ws, "ws://127.0.0.1:8090/agent");
        assert_eq!(cfg.rpc_url, "https://sepolia.base.org");
    }

    #[test]
    fn requires_a_key_source_and_settlement() {
        // No key source at all.
        assert!(matches!(
            AgentConfig::from_lookup(map(&[("DAWN_SETTLEMENT", "0x1")])),
            Err(ConfigError::Missing("DAWN_KEYSTORE or DAWN_NODE_KEY"))
        ));
        // Key present but settlement missing.
        assert!(matches!(
            AgentConfig::from_lookup(map(&[("DAWN_NODE_KEY", "0x1")])),
            Err(ConfigError::Missing("DAWN_SETTLEMENT"))
        ));
    }

    #[test]
    fn keystore_path_satisfies_key_source() {
        let cfg = AgentConfig::from_lookup(map(&[
            ("DAWN_KEYSTORE", "/home/node/dawn.keystore"),
            ("DAWN_KEYSTORE_PASS", "pw"),
            ("DAWN_SETTLEMENT", "0x2"),
        ]))
        .unwrap();
        assert_eq!(
            cfg.keystore_path.as_deref(),
            Some("/home/node/dawn.keystore")
        );
        assert!(cfg.node_key.is_none());
    }

    #[test]
    fn rejects_bad_chain_id() {
        assert!(matches!(
            AgentConfig::from_lookup(map(&[
                ("DAWN_NODE_KEY", "0x1"),
                ("DAWN_SETTLEMENT", "0x2"),
                ("DAWN_CHAIN_ID", "not-a-number"),
            ])),
            Err(ConfigError::Bad(_))
        ));
    }

    #[test]
    fn overrides_take_effect() {
        let cfg = AgentConfig::from_lookup(map(&[
            ("DAWN_NODE_KEY", "0x1"),
            ("DAWN_SETTLEMENT", "0x2"),
            ("DAWN_CHAIN_ID", "8453"),
            ("DAWN_BACKEND_WS", "ws://host:9/agent"),
        ]))
        .unwrap();
        assert_eq!(cfg.chain_id, 8453);
        assert_eq!(cfg.backend_ws, "ws://host:9/agent");
    }
}
