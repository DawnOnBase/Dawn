//! Read-only connectivity probe for the on-chain client. Builds `OnchainSettlement`
//! and reads `jobStatus(jobId)` from the live contract — no gas, no signing — to
//! confirm the alloy/reqwest HTTP transport works (e.g. after a runtime-binding fix).
//!
//! ```text
//! DAWN_RPC_URL=https://sepolia.base.org \
//! DAWN_SETTLEMENT=0xc27C681cE93a63C0987226CDaC7b66232018651E \
//! PROBE_JOBID=0x<bytes32> \
//! cargo run --example onchain_probe --features onchain
//! ```

use dawn_agent::onchain::OnchainSettlement;
use dawn_agent::payout::SettlementRpc;

fn main() {
    let rpc = std::env::var("DAWN_RPC_URL").unwrap_or_else(|_| "https://sepolia.base.org".into());
    let settlement = std::env::var("DAWN_SETTLEMENT").expect("set DAWN_SETTLEMENT");
    let job_id = std::env::var("PROBE_JOBID").expect("set PROBE_JOBID (0x bytes32)");
    // A read-only call never signs, so any well-formed key works as the provider's wallet.
    let key = std::env::var("DAWN_NODE_KEY").unwrap_or_else(|_| {
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d".into()
    });

    let probe = OnchainSettlement::new(&rpc, &settlement, &key).expect("build client");
    match probe.job_status(&job_id) {
        Ok(status) => println!("onchain-probe: jobStatus({job_id}) = {status:?}  ✅ transport OK"),
        Err(e) => {
            eprintln!("onchain-probe: {e}");
            std::process::exit(1);
        }
    }
}
