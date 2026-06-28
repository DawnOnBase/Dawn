//! Dawn desktop agent library .
//!
//! the backend scope: the Idle Detector (when is the machine truly idle) and
//! the Job Runner (sandboxed execution + output hashing). The Proof Engine and
//! Payout Manager are the agent and consume `runner::JobOutput`.
//!
//! `protocol` mirrors the shared agent↔backend protocol (packages/shared).

pub mod config;
pub mod fetch;
pub mod idle;
pub mod jobpkg;
pub mod keystore;
#[cfg(feature = "onchain")]
pub mod onchain;
pub mod outbox;
pub mod payout;
pub mod probes;
pub mod proof;
pub mod protocol;
pub mod runner;
pub mod transport;
pub mod wallet;
pub mod watchsource;
pub mod watchtower;
