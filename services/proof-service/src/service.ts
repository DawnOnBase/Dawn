// Proof validation + redundancy orchestration . Receives proof
// submissions (from job-queue's coordinator), validates each, accumulates them
// per job, and once a quorum agrees hands the decision to on-chain settlement.
//
// Two seams are interfaces so this builds/tests without crypto or a chain:
//   - SignatureVerifier: recover/verify the EIP-712 node signature
//   - SettlementSink:     release USDC payout + flag dissenters (agent)

import type { Address, Hex, ProofBundle } from "@dawn/shared";
import { computeConsensus, hasQuorum, type ProofSubmission } from "./consensus.ts";

export interface SignatureVerifier {
  // Returns the node address that signed the proof, or throws if invalid.
  recover(proof: ProofBundle): Promise<Address>;
}

export interface SettlementInstruction {
  jobId: Hex;
  outputHash: Hex;
  operator: Address; // the agreeing node paid on-chain (settle's payee)
  proof: ProofBundle; // the winning bundle the contract re-verifies (EIP-712)
  pay: Address[]; // nodes that agreed
  penalize: Address[]; // nodes that dissented (lose bond)
  // Per-agreeing-operator (proof, merkleProof) so a redundant settler can drive the on-chain
  // submitProof(proof, operator, merkleProof) for every winner. Empty merkleProof = single-node.
  winners: { operator: Address; proof: ProofBundle; merkleProof: Hex[] }[];
}

export interface SettlementSink {
  settle(instr: SettlementInstruction): Promise<void>;
}

export interface ProofStore {
  add(jobId: Hex, sub: ProofSubmission): Promise<number>; // returns count for job
  list(jobId: Hex): Promise<ProofSubmission[]>;
}

export class InMemoryProofStore implements ProofStore {
  private readonly byJob = new Map<Hex, ProofSubmission[]>();
  async add(jobId: Hex, sub: ProofSubmission): Promise<number> {
    const list = this.byJob.get(jobId) ?? [];
    list.push(sub);
    this.byJob.set(jobId, list);
    return list.length;
  }
  async list(jobId: Hex): Promise<ProofSubmission[]> {
    return this.byJob.get(jobId) ?? [];
  }
}

export interface SubmitOutcome {
  accepted: boolean;
  decided: boolean;
  outputHash?: Hex;
  reason?: string;
}

export class ProofService {
  constructor(
    private readonly verifier: SignatureVerifier,
    private readonly store: ProofStore,
    private readonly settlement: SettlementSink,
  ) {}

  /**
   * Validate and record a proof for a job with the given redundancy. When a
   * quorum of agreeing outputs is reached, settle once.
   */
  async submit(proof: ProofBundle, redundancy: number, merkleProof?: Hex[]): Promise<SubmitOutcome> {
    let node: Address;
    try {
      node = await this.verifier.recover(proof);
    } catch (err) {
      return { accepted: false, decided: false, reason: `invalid signature: ${(err as Error).message}` };
    }

    await this.store.add(proof.jobId, { node, proof, merkleProof });
    const subs = await this.store.list(proof.jobId);

    // Single-node (redundancy <= 1): the AGENT self-settles on-chain (a design decision,
    // the proven path). The proof-service only verifies + records here — settling
    // would be a SECOND settler racing the agent (a NOT_ESCROWED revert + wasted gas).
    // The redundant flow (redundancy > 1) settles server-side after quorum (below).
    if (redundancy <= 1) {
      return { accepted: true, decided: true, outputHash: proof.outputHash };
    }

    if (!hasQuorum(subs.length, redundancy)) {
      return { accepted: true, decided: false };
    }

    const result = computeConsensus(subs, redundancy);
    if (!result.decided || result.outputHash === undefined) {
      return { accepted: true, decided: false, reason: "no quorum agreement yet" };
    }

    // The on-chain contract re-verifies one winning bundle against its operator;
    // pick the first agreeing submission whose output is the consensus output.
    const winner = subs.find((s) => s.proof.outputHash === result.outputHash);
    if (!winner) {
      return { accepted: true, decided: false, reason: "consensus output has no backing submission" };
    }

    // Every agreeing submission with its membership proof, so a redundant settler can submit each
    // winner on-chain (submitProof(proof, operator, merkleProof)).
    const winners = subs
      .filter((s) => s.proof.outputHash === result.outputHash)
      .map((s) => ({ operator: s.node, proof: s.proof, merkleProof: s.merkleProof ?? [] }));

    await this.settlement.settle({
      jobId: proof.jobId,
      outputHash: result.outputHash,
      operator: winner.node,
      proof: winner.proof,
      pay: result.agreeing,
      penalize: result.dissenting,
      winners,
    });
    return { accepted: true, decided: true, outputHash: result.outputHash };
  }
}
