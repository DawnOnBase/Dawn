import { describe, expect, test } from "bun:test";
import type { Address, Hex, ProofBundle } from "@dawn/shared";
import { computeConsensus, hasQuorum, type ProofSubmission } from "../src/consensus.ts";

function sub(node: string, outputHash: string): ProofSubmission {
  const proof: ProofBundle = {
    jobId: "0xjob" as Hex,
    inputHash: "0xin" as Hex,
    outputHash: outputHash as Hex,
    metadata: "0x" as Hex,
    nodeSignature: node as Hex,
  };
  return { node: node as Address, proof };
}

describe("computeConsensus", () => {
  test("redundancy 1: single proof is authoritative", () => {
    const r = computeConsensus([sub("0xa", "0xout")], 1);
    expect(r.decided).toBe(true);
    expect(r.outputHash).toBe("0xout");
    expect(r.agreeing).toEqual(["0xa"]);
    expect(r.dissenting).toEqual([]);
  });

  test("3-of-3 agreement pays all", () => {
    const r = computeConsensus([sub("0xa", "0xout"), sub("0xb", "0xout"), sub("0xc", "0xout")], 3);
    expect(r.decided).toBe(true);
    expect(r.agreeing.length).toBe(3);
    expect(r.dissenting).toEqual([]);
  });

  test("2-of-3 agreement decides and flags the dissenter", () => {
    const r = computeConsensus([sub("0xa", "0xout"), sub("0xb", "0xout"), sub("0xc", "0xEVIL")], 3);
    expect(r.decided).toBe(true);
    expect(r.outputHash).toBe("0xout");
    expect(r.agreeing.sort()).toEqual(["0xa", "0xb"]);
    expect(r.dissenting).toEqual(["0xc"]);
  });

  test("no majority => undecided", () => {
    const r = computeConsensus([sub("0xa", "0x1"), sub("0xb", "0x2"), sub("0xc", "0x3")], 3);
    expect(r.decided).toBe(false);
    expect(r.outputHash).toBeUndefined();
  });

  test("not enough submissions yet => undecided", () => {
    const r = computeConsensus([sub("0xa", "0xout")], 3); // need 2 of 3
    expect(r.decided).toBe(false);
  });
});

describe("hasQuorum", () => {
  // Super-plurality ceil(r*2/3), byte-identical to Settlement._quorum ((2r+2)/3). The proof-service
  // is the redundant settler-of-record, so this MUST match the contract — NOT a simple majority,
  // which diverges at r>=5 (5 needs 4 agreeing reveals, not 3).
  test("quorum is the contract super-plurality ceil(r*2/3)", () => {
    expect(hasQuorum(1, 1)).toBe(true);
    expect(hasQuorum(1, 3)).toBe(false);
    expect(hasQuorum(2, 3)).toBe(true); // 3 -> 2
    expect(hasQuorum(2, 4)).toBe(false);
    expect(hasQuorum(3, 4)).toBe(true); // 4 -> 3
    expect(hasQuorum(3, 5)).toBe(false); // 5 -> 4 (was 3 under the old majority)
    expect(hasQuorum(4, 5)).toBe(true);
  });
});
