// Dev/test seam implementations. Replace before production.

import type { Address, ProofBundle } from "@dawn/shared";
import type { SettlementInstruction, SettlementSink, SignatureVerifier } from "./service.ts";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

// StubSignatureVerifier treats the proof's nodeSignature field as the node
// address itself — NO real cryptography. Dev/tests only.
// TODO(shared): real EIP-712 recover over the Proof typed data, asserting
// the recovered address == the job's assigned operator.
export class StubSignatureVerifier implements SignatureVerifier {
  async recover(proof: ProofBundle): Promise<Address> {
    if (ADDR.test(proof.nodeSignature)) return proof.nodeSignature as Address;
    throw new Error("stub verifier expects nodeSignature to be a 0x address");
  }
}

// LoggingSettlementSink records instructions instead of touching a chain.
// TODO(agent): submit the consensus result to the Settlement
// contract (release USDC to `pay`, slash bonds of `penalize`).
export class LoggingSettlementSink implements SettlementSink {
  public readonly settled: SettlementInstruction[] = [];
  async settle(instr: SettlementInstruction): Promise<void> {
    this.settled.push(instr);
    // eslint-disable-next-line no-console
    console.log(`proof-service: settle job=${instr.jobId} pay=${instr.pay.length} penalize=${instr.penalize.length}`);
  }
}
