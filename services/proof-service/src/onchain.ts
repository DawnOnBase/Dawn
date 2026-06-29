// Production seams for the proof-service .
//
//  - Eip712SignatureVerifier: recovers the node address from the proof's EIP-712
//    signature, exactly as Settlement.sol does on-chain. Replaces the dev stub.
//  - OnchainSettlementSink: submits the consensus result to the Settlement
//    contract (single-node `settle(proof, operator)`), releasing USDC to the
//    operator and taking the protocol fee.

import type { Address, Hex, ProofBundle } from "@dawn/shared";
import { recoverProofSigner } from "@dawn/shared/web3";
import type { SettlementInstruction, SettlementSink, SignatureVerifier } from "./service.ts";

/** Recovers the proof signer via EIP-712 over the "Dawn Settlement" domain. */
export class Eip712SignatureVerifier implements SignatureVerifier {
  constructor(
    private readonly chainId: number,
    private readonly settlement: Address,
  ) {}

  recover(proof: ProofBundle): Promise<Address> {
    return recoverProofSigner(proof.nodeSignature, proof, this.chainId, this.settlement);
  }
}

/** Minimal write surface OnchainSettlementSink needs (SettlementClient satisfies it). */
export interface SettleWriter {
  settle(proof: ProofBundle, operator: Address): Promise<Hex>;
}

/** Submits decided proofs to the Settlement contract (single-node flow). */
export class OnchainSettlementSink implements SettlementSink {
  constructor(private readonly client: SettleWriter) {}

  async settle(instr: SettlementInstruction): Promise<void> {
    // This sink calls single-node settle(); a redundant instruction (a committee of >1 winners)
    // must NEVER reach it — it would hit the wrong entrypoint (the contract reverts USE_SUBMIT_PROOF).
    // Reject the misroute loudly rather than dropping a penalty or hitting the wrong path.
    if (instr.winners.length > 1) {
      throw new Error(
        `onchain settle: redundant instruction (${instr.winners.length} winners) misrouted to the single-node sink — use RedundantSettlementSink`,
      );
    }
    // Slashing dissenters belongs to the redundant flow, which is disabled
    // in-contract (single-node only ships). Guard so a misconfigured redundant
    // job can't silently drop a penalty.
    if (instr.penalize.length > 0) {
      throw new Error("onchain settle: redundant slashing is disabled (single-node only)");
    }
    const txHash = await this.client.settle(instr.proof, instr.operator);
    // eslint-disable-next-line no-console
    console.log(`proof-service: settled job=${instr.jobId} operator=${instr.operator} tx=${txHash}`);
  }
}

/** Minimal write surface RedundantSettlementSink needs (SettlementClient satisfies it). */
export interface RedundantSettleWriter {
  submitProof(proof: ProofBundle, operator: Address, merkleProof: Hex[]): Promise<Hex>;
}

/**
 * Seam S3 — the redundant-flow settler-of-record (M0 D3). On consensus, submits each winning
 * committee member's signed proof on-chain via submitProof(proof, operator, merkleProof). The
 * contract freezes at the super-plurality quorum, and ProofService.submit calls this the instant
 * quorum AGREEING is reached, so `winners.length` equals the quorum exactly — every submission
 * lands (the quorum-th flips the job to PendingConsensus; none revert NOT_ESCROWED).
 *
 * Payout is pull-based + challenge-window-gated: claim() runs AFTER CHALLENGE_WINDOW as a separate
 * keeper step (it must not expect instant payout), so this sink only drives consensus — it never
 * calls settle() or claim().
 */
export class RedundantSettlementSink implements SettlementSink {
  constructor(private readonly client: RedundantSettleWriter) {}

  async settle(instr: SettlementInstruction): Promise<void> {
    if (instr.winners.length <= 1) {
      // A redundant job always settles a committee of >1 agreeing winners; <=1 means a single-node
      // instruction was misrouted here. Fail loudly rather than driving the wrong on-chain path.
      throw new Error(
        `redundant settle: expected a committee (>1 winner), got ${instr.winners.length} — single-node uses OnchainSettlementSink`,
      );
    }
    for (const w of instr.winners) {
      const txHash = await this.client.submitProof(w.proof, w.operator, w.merkleProof);
      // eslint-disable-next-line no-console
      console.log(`proof-service: redundant submitProof job=${instr.jobId} operator=${w.operator} tx=${txHash}`);
    }
  }
}
