// Agent <-> Backend protocol .
// Transport: WebSocket, JSON messages. Auth: node-wallet signature on `hello`.
// shared — changing message shapes requires both owners' sign-off.

import type { Address, Hex, NodeProfile, ProofBundle } from "./types";

export type AgentToBackend =
  | { t: "hello"; nodeId: Address; sig: Hex; profile: NodeProfile }
  | { t: "pull_job" }
  | { t: "heartbeat"; ts: number }
  | { t: "submit_result"; proof: ProofBundle; resultRef: string };

export type BackendToAgent =
  | {
      t: "job_assignment";
      jobId: Hex;
      inputRef: string;
      deadline: number;
      // M9 redundant fields — present ONLY for an M-of-N committee member (additive; a single-node
      // job_assignment omits them). The agent submits with `merkleProof` against `operatorSetRoot`;
      // `assignmentSig` is the orchestrator authorization the contract verifies. See M9 doc
      operatorSetRoot?: Hex;
      assignmentSig?: Hex;
      merkleProof?: Hex[];
      redundancy?: number;
      nonce?: number;
      bond?: string;
    }
  | { t: "no_job" }
  | { t: "ack"; jobId: Hex }
  | { t: "pause" }
  | { t: "resume" };

/**
 * HELLO_AUTH (v1) — how a node proves control of its wallet on `hello`.
 *
 * The node signs `helloAuthMessage(nodeId)` with its node-wallet private key via
 * EIP-191 `personal_sign`; `sig` is the 0x-prefixed r‖s‖v (65-byte) result. The
 * backend recovers the signer and asserts it equals `nodeId` (the operator
 * address paid on-chain). Agent side: apps/agent/src/wallet.rs; backend verify
 * replaces job-queue's AllowAllAuth (internal/coordinator). Keep this string
 * byte-identical across all three. v1 is replayable (no nonce) — add a
 * nonce/timestamp before opening to untrusted nodes.
 */
export function helloAuthMessage(nodeId: Address): string {
  return `Dawn agent hello\nnode: ${nodeId}`;
}
