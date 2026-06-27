// Shared source of truth  — agreed by the Dawn team.
// These mirror the on-chain structs where applicable. Do NOT change without
// both owners' sign-off; the indexer, API, agent, and contracts all depend on them.

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Lifecycle of a job across the backend + chain. */
export enum JobStatus {
  Submitted = "submitted",
  Escrowed = "escrowed",
  Matched = "matched",
  Running = "running",
  Proven = "proven",
  Settled = "settled",
  Failed = "failed",
  TimedOut = "timed_out",
}

export type JobType =
  | "inference"
  | "data_processing"
  | "rendering"
  | "fine_tune_shard"
  | "general_compute";

/**
 * Anonymized hardware profile — never expose exact device model (privacy, the architecture).
 * The node wallet address is the only identity.
 */
export interface NodeProfile {
  nodeId: Address;
  gpuTier: number | null; // coarse tier, e.g. 1..5; null = CPU-only
  vramGb: number | null;
  cpuCores: number;
  ramGb: number;
  region: string; // coarse geo, e.g. "us-east"
  reliabilityScore: number; // 0..1, from historical completion 
}

export interface JobRequirements {
  jobType: JobType;
  minGpuTier?: number;
  minVramGb?: number;
  minCpuCores?: number;
  minRamGb?: number;
  estimatedDurationSec: number;
  /** >1 => redundant execution + consensus for high-value jobs . */
  redundancy?: number;
}

export interface Job {
  /** keccak256 id; the same value is used as `jobId` in the Settlement contract. */
  jobId: Hex;
  buyer: Address;
  requirements: JobRequirements;
  /** USDC base units (6 decimals) as a string to avoid float precision loss. */
  amountUsdc: string;
  deadline: number; // unix seconds
  status: JobStatus;
  operator?: Address; // assigned node, once matched (single-node)

  // --- M9 redundant-execution fields (the redundant-execution design). Absent for single-node
  // jobs, so the single-node shape is unchanged. Mirror of domain.Job (Go). ---
  /** keccak256(canonical Job Package); orchestrator-pinned, the value the contract gates submitProof on. */
  inputHash?: Hex;
  /** The M authorized committee, in assignment (Merkle) order. */
  operators?: Address[];
  /** Sorted-pair Merkle root over `operators`. */
  operatorSetRoot?: Hex;
  /** Orchestrator EIP-712 Assignment signature authorizing the committee. */
  assignmentSig?: Hex;
  /** Monotonic per jobId from the orchestrator (replay-safe; nonce+1 on re-run). */
  nonce?: number;
  /** Per-job operator bond, USDC base units (string, like amountUsdc). */
  bond?: string;
}

/**
 * Proof of execution — mirrors `ISettlement.ProofBundle`.
 * `nodeSignature` is an EIP-712 signature by the node wallet over the `Proof` typed data
 * (domain "Dawn Settlement" v1, bound to chainId + the Settlement address). Encoded packed
 * as (r, s, v), 65 bytes, low-s only. See the shared README for the exact domain + type.
 */
export interface ProofBundle {
  jobId: Hex;
  inputHash: Hex;
  outputHash: Hex;
  metadata: Hex; // abi-encoded: duration, resource usage, timestamps
  nodeSignature: Hex;
}
