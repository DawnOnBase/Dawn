// Redundant-execution consensus . High-value jobs are run
// by N nodes; payout is released only when their output hashes agree. This
// module is pure logic — given the submissions for a job, it decides whether a
// quorum agrees and who the dissenters are (penalized; bonded in USDC pre-token).

import type { Address, Hex, ProofBundle } from "@dawn/shared";

export interface ProofSubmission {
  node: Address; // recovered from / asserted by the node signature
  proof: ProofBundle;
  // Committee-membership Merkle proof (redundant jobs only). The on-chain redundant settler needs
  // it to call submitProof(proof, operator, merkleProof). Absent for single-node.
  merkleProof?: Hex[];
}

export interface ConsensusResult {
  decided: boolean;
  outputHash?: Hex; // the agreed output, when decided
  agreeing: Address[]; // nodes to pay
  dissenting: Address[]; // nodes that produced a different output -> penalize
}

/**
 * Super-plurality quorum threshold, byte-identical to Settlement._quorum: ceil(r * 2/3) computed as
 * (2*r + 2)/3. For 1→1, 2→2, 3→2, 4→3, 5→4. This MUST match the contract — the proof-service is the
 * redundant settler-of-record (M0 D3), so settling below the contract's threshold would submit a
 * decision the chain then rejects (or pays too few winners). NOT a simple majority floor(r/2)+1,
 * which diverges from the contract at r>=5 (5 would settle at 3 instead of 4).
 */
export function quorumThreshold(redundancy: number): number {
  const r = Math.max(1, Math.floor(redundancy));
  return Math.floor((2 * r + 2) / 3);
}

/**
 * Decide consensus over the submissions for one job.
 * @param redundancy the configured execution count (>=1).
 * Quorum = super-plurality ceil(r * 2/3) (e.g. 2 of 3, 4 of 5), matching the contract. With
 * redundancy 1, a single proof is authoritative.
 */
export function computeConsensus(subs: ProofSubmission[], redundancy: number): ConsensusResult {
  const quorum = quorumThreshold(redundancy);

  // Tally votes per outputHash, keeping the first-seen order for determinism.
  const byHash = new Map<Hex, Address[]>();
  for (const s of subs) {
    const h = s.proof.outputHash;
    const list = byHash.get(h);
    if (list) list.push(s.node);
    else byHash.set(h, [s.node]);
  }

  let winner: Hex | undefined;
  let winnerNodes: Address[] = [];
  for (const [hash, nodes] of byHash) {
    if (nodes.length > winnerNodes.length) {
      winner = hash;
      winnerNodes = nodes;
    }
  }

  if (winner === undefined || winnerNodes.length < quorum) {
    return { decided: false, agreeing: [], dissenting: [] };
  }

  const dissenting: Address[] = [];
  for (const s of subs) {
    if (s.proof.outputHash !== winner) dissenting.push(s.node);
  }

  return { decided: true, outputHash: winner, agreeing: winnerNodes, dissenting };
}

/** Whether enough submissions exist to attempt consensus for a redundancy level. */
export function hasQuorum(count: number, redundancy: number): boolean {
  return count >= quorumThreshold(redundancy);
}
