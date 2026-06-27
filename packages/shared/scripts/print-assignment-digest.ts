// Prints the TS Assignment digest for the same fixed input the Go orchestrator_test and
// contracts/script/PrintM9Ref.s.sol use, so all three (Solidity / Go / TS) can be diffed in CI.
// If they disagree, an orchestrator signature produced in one language would be rejected on-chain.

import { keccak256, toBytes } from "viem";
import { assignmentDigest } from "../src/web3/eip712";

// Same fixture as orchestrator_test.go (refChainID / refSettlement / fixtureAssignment).
const digest = assignmentDigest(
  {
    jobId: keccak256(toBytes("job")),
    inputHash: keccak256(toBytes("in")),
    operatorSetRoot: keccak256(toBytes("opset")),
    redundancy: 3,
    deadline: 1000000n,
    amount: 100000000n,
    bond: 10000000n,
    nonce: 1n,
  },
  31337,
  "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3",
);

console.log(digest);
