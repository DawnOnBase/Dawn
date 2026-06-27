// Cross-checks the TS EIP-712 helpers against the on-chain reference values printed by
// contracts/script/PrintDigest.s.sol. If the digest/domain don't match, node signatures would
// silently fail on-chain — so this guards the shared proof seam.
//
// Usage: bun scripts/verify-eip712.ts <path-to-forge-script-output.log>

import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, proofDigest, type ProofMessage } from "../src/web3/eip712";

const log = readFileSync(process.argv[2], "utf8");

function grab(label: string): string {
  const m = log.match(new RegExp(`${label}\\s+(\\S+)`));
  if (!m) throw new Error(`could not find "${label}" in forge output`);
  return m[1];
}

const chainId = Number(grab("CHAINID"));
const settlement = grab("SETTLEMENT") as Address;
const expectedDomSep = grab("DOMSEP") as Hex;
const expectedDigest = grab("DIGEST") as Hex;

// Same fixed proof as PrintDigest.s.sol (keccak of the UTF-8 string bytes).
const proof: ProofMessage = {
  jobId: keccak256(toBytes("job")),
  inputHash: keccak256(toBytes("in")),
  outputHash: keccak256(toBytes("out")),
  metadata: toHex(toBytes("meta")),
};

// Independently recompute the domain separator the way the contract does.
const DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const tsDomSep = keccak256(
  encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [
    DOMAIN_TYPEHASH,
    keccak256(toBytes(EIP712_DOMAIN_NAME)),
    keccak256(toBytes(EIP712_DOMAIN_VERSION)),
    BigInt(chainId),
    settlement,
  ]),
);

const tsDigest = proofDigest(proof, chainId, settlement);

function check(name: string, got: string, want: string) {
  const ok = got.toLowerCase() === want.toLowerCase();
  console.log(`${ok ? "PASS" : "FAIL"} ${name}\n  ts  = ${got}\n  sol = ${want}`);
  if (!ok) process.exitCode = 1;
}

console.log(`chainId=${chainId} settlement=${settlement}`);
check("domainSeparator", tsDomSep, expectedDomSep);
check("proofDigest", tsDigest, expectedDigest);

if (process.exitCode) {
  console.error("\nEIP-712 mismatch — TS client and Settlement.sol disagree.");
} else {
  console.log("\nOK — TS EIP-712 matches Settlement.sol.");
}
