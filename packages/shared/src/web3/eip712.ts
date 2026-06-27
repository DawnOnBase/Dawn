// EIP-712 proof signing/verification — must match Settlement.sol exactly (shared seam).
// The contract signs/verifies a `Proof` typed struct under the "Dawn Settlement" domain,
// bound to chainId + the Settlement address. See contracts/src/Settlement.sol.

import { hashTypedData, keccak256, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const EIP712_DOMAIN_NAME = "Dawn Settlement";
export const EIP712_DOMAIN_VERSION = "1";

// Matches Settlement._PROOF_TYPEHASH.
export const PROOF_TYPES = {
  Proof: [
    { name: "jobId", type: "bytes32" },
    { name: "inputHash", type: "bytes32" },
    { name: "outputHash", type: "bytes32" },
    { name: "metadataHash", type: "bytes32" },
  ],
} as const;

// Matches Settlement._ASSIGNMENT_TYPEHASH + the Go orchestrator's assignmentType (M9 doc).
// The orchestrator, NOT a node, signs this — it authorizes an M-of-N committee for a job.
// Field order is the signed-struct order and MUST stay byte-identical across Solidity/Go/TS.
export const ASSIGNMENT_TYPES = {
  Assignment: [
    { name: "jobId", type: "bytes32" },
    { name: "inputHash", type: "bytes32" },
    { name: "operatorSetRoot", type: "bytes32" },
    { name: "redundancy", type: "uint16" },
    { name: "deadline", type: "uint64" },
    { name: "amount", type: "uint256" },
    { name: "bond", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function settlementDomain(chainId: number, settlement: Address) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: settlement,
  } as const;
}

/** The fields a node attests to. `metadata` is the raw bytes; it is hashed into `metadataHash`. */
export interface ProofMessage {
  jobId: Hex;
  inputHash: Hex;
  outputHash: Hex;
  metadata: Hex;
}

function typedData(proof: ProofMessage, chainId: number, settlement: Address) {
  return {
    domain: settlementDomain(chainId, settlement),
    types: PROOF_TYPES,
    primaryType: "Proof" as const,
    message: {
      jobId: proof.jobId,
      inputHash: proof.inputHash,
      outputHash: proof.outputHash,
      metadataHash: keccak256(proof.metadata),
    },
  };
}

/** EIP-712 digest a node signs — equals Settlement.proofDigest(proof) on-chain. */
export function proofDigest(proof: ProofMessage, chainId: number, settlement: Address): Hex {
  return hashTypedData(typedData(proof, chainId, settlement));
}

/** Sign a proof with a node private key. Returns the 65-byte (r,s,v) signature for `ProofBundle.nodeSignature`. */
export function signProof(privateKey: Hex, proof: ProofMessage, chainId: number, settlement: Address): Promise<Hex> {
  return privateKeyToAccount(privateKey).signTypedData(typedData(proof, chainId, settlement));
}

/** Recover the signer of a proof signature — what the contract / proof-service check against `operator`. */
export function recoverProofSigner(
  signature: Hex,
  proof: ProofMessage,
  chainId: number,
  settlement: Address,
): Promise<Address> {
  return recoverTypedDataAddress({ ...typedData(proof, chainId, settlement), signature });
}

/** The committee authorization the orchestrator signs (mirrors orchestrator.Assignment in Go). */
export interface AssignmentMessage {
  jobId: Hex;
  inputHash: Hex;
  operatorSetRoot: Hex;
  redundancy: number;
  deadline: bigint;
  amount: bigint;
  bond: bigint;
  nonce: bigint;
}

function assignmentTypedData(a: AssignmentMessage, chainId: number, settlement: Address) {
  return {
    domain: settlementDomain(chainId, settlement),
    types: ASSIGNMENT_TYPES,
    primaryType: "Assignment" as const,
    message: {
      jobId: a.jobId,
      inputHash: a.inputHash,
      operatorSetRoot: a.operatorSetRoot,
      redundancy: a.redundancy,
      deadline: a.deadline,
      amount: a.amount,
      bond: a.bond,
      nonce: a.nonce,
    },
  };
}

/** EIP-712 digest the orchestrator signs — equals Settlement.assignmentDigest(e) on-chain. */
export function assignmentDigest(a: AssignmentMessage, chainId: number, settlement: Address): Hex {
  return hashTypedData(assignmentTypedData(a, chainId, settlement));
}

/** Recover the orchestrator that signed an Assignment — checked against the contract's `orchestrator`. */
export function recoverAssignmentSigner(
  signature: Hex,
  a: AssignmentMessage,
  chainId: number,
  settlement: Address,
): Promise<Address> {
  return recoverTypedDataAddress({ ...assignmentTypedData(a, chainId, settlement), signature });
}
