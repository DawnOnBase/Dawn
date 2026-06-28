//! Prints the agent's EIP-712 proof digest for a fixed input, so CI can confirm it
//! matches the TS client (packages/shared) and the contract. Run: cargo run --example print_digest

use dawn_agent::proof::proof_digest;
use dawn_agent::runner::keccak_hex;

fn main() {
    let mut settlement = [0u8; 20];
    settlement[19] = 1; // 0x0000...0001

    let digest = proof_digest(
        &keccak_hex(b"job"),
        &keccak_hex(b"in"),
        &keccak_hex(b"out"),
        b"meta",
        8453,
        &settlement,
    )
    .expect("digest");

    let mut hex = String::from("0x");
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    println!("{hex}");
}
