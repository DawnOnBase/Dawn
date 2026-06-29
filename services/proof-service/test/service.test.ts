import { describe, expect, test } from "bun:test";
import type { Address, Hex, ProofBundle } from "@dawn/shared";
import { buildApp } from "../src/app.ts";
import { LoggingSettlementSink, StubSignatureVerifier } from "../src/adapters.ts";
import { InMemoryProofStore, ProofService } from "../src/service.ts";

function proof(node: string, outputHash: string, jobId = "0xjob"): ProofBundle {
  return {
    jobId: jobId as Hex,
    inputHash: "0xin" as Hex,
    outputHash: outputHash as Hex,
    metadata: "0x" as Hex,
    nodeSignature: node as Hex, // stub verifier treats this as the node address
  };
}

function make() {
  const sink = new LoggingSettlementSink();
  const service = new ProofService(new StubSignatureVerifier(), new InMemoryProofStore(), sink);
  return { service, sink };
}

const NODE_A = ("0x" + "a".repeat(40)) as Address;
const NODE_B = ("0x" + "b".repeat(40)) as Address;
const NODE_C = ("0x" + "c".repeat(40)) as Address;

describe("ProofService.submit", () => {
  test("redundancy 1 is verified + recorded but NOT settled here (agent self-settles, D3)", async () => {
    const { service, sink } = make();
    const out = await service.submit(proof(NODE_A, "0xout"), 1);
    expect(out.decided).toBe(true);
    expect(out.outputHash).toBe("0xout");
    expect(sink.settled.length).toBe(0); // single-node settler is the agent, not the proof-service
  });

  test("redundancy 3 settles only once quorum agrees", async () => {
    const { service, sink } = make();
    expect((await service.submit(proof(NODE_A, "0xout"), 3)).decided).toBe(false);
    const second = await service.submit(proof(NODE_B, "0xout"), 3);
    expect(second.decided).toBe(true); // 2 of 3
    expect(sink.settled.length).toBe(1);
    expect(sink.settled[0]!.outputHash).toBe("0xout");
  });

  test("redundant settle carries each winner's merkleProof for on-chain submitProof", async () => {
    const { service, sink } = make();
    await service.submit(proof(NODE_A, "0xout"), 3, ["0xa1", "0xa2"] as Hex[]);
    await service.submit(proof(NODE_B, "0xout"), 3, ["0xb1", "0xb2"] as Hex[]);
    const winners = sink.settled[0]!.winners;
    expect(winners.length).toBe(2);
    const a = winners.find((w) => w.operator === NODE_A);
    expect(a?.merkleProof).toEqual(["0xa1", "0xa2"] as Hex[]);
  });

  test("dissenting node is flagged for penalty", async () => {
    const { service, sink } = make();
    await service.submit(proof(NODE_A, "0xout"), 3);
    await service.submit(proof(NODE_C, "0xEVIL"), 3); // dissent
    const third = await service.submit(proof(NODE_B, "0xout"), 3);
    expect(third.decided).toBe(true);
    expect(sink.settled[0]!.penalize).toContain(NODE_C);
    expect(sink.settled[0]!.pay.sort()).toEqual([NODE_A, NODE_B].sort());
  });

  test("rejects an unrecoverable signature", async () => {
    const { service } = make();
    const bad = await service.submit(proof("not-an-address", "0xout"), 1);
    expect(bad.accepted).toBe(false);
  });
});

describe("proof-service HTTP", () => {
  test("POST /v1/proofs validates and accepts", async () => {
    const { service } = make();
    const app = buildApp({ service });
    const bad = await app.inject({ method: "POST", url: "/v1/proofs", payload: { proof: { jobId: "0xj" } } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/v1/proofs",
      payload: { proof: proof(NODE_A, "0xout"), redundancy: 1 },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().decided).toBe(true);
  });
});
