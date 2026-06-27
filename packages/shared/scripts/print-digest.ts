// Prints the TS proof digest for the same fixed input as the agent's
// `cargo run --example print_digest`, so the two can be diffed in CI.

import { keccak256, toBytes, toHex } from "viem";
import { proofDigest } from "../src/web3/eip712";

const proof = {
  jobId: keccak256(toBytes("job")),
  inputHash: keccak256(toBytes("in")),
  outputHash: keccak256(toBytes("out")),
  metadata: toHex(toBytes("meta")),
};

console.log(proofDigest(proof, 8453, "0x0000000000000000000000000000000000000001"));
