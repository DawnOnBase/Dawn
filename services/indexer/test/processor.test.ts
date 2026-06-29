import { describe, expect, test } from "bun:test";
import { JobStatus } from "@dawn/shared";
import type { SettlementEvent } from "../src/events.ts";
import { EventProcessor } from "../src/processor.ts";
import { Indexer } from "../src/indexer.ts";
import { ArrayLogSource } from "../src/source.ts";
import { InMemoryJobStateWriter } from "../src/state.ts";

const BUYER = "0x1111111111111111111111111111111111111111";
const OP = "0x2222222222222222222222222222222222222222";
const TREASURY = "0x3333333333333333333333333333333333333333";

function escrowed(jobId: string, block: number, logIndex = 0): SettlementEvent {
  return { kind: "JobEscrowed", jobId: jobId as `0x${string}`, buyer: BUYER, amountUsdc: "5000000", deadline: 9000, blockNumber: block, logIndex, txHash: "0xtx" };
}
function settled(jobId: string, block: number, logIndex = 0): SettlementEvent {
  return { kind: "JobSettled", jobId: jobId as `0x${string}`, operator: OP, amountUsdc: "4975000", feeUsdc: "25000", blockNumber: block, logIndex, txHash: "0xtx" };
}

describe("EventProcessor", () => {
  test("JobEscrowed sets status escrowed", async () => {
    const w = new InMemoryJobStateWriter();
    const p = new EventProcessor(w);
    expect(await p.apply(escrowed("0xj1", 10))).toBe(true);
    expect(w.status.get("0xj1")).toBe(JobStatus.Escrowed);
    expect(p.position()).toEqual({ blockNumber: 10, logIndex: 0 });
  });

  test("JobSettled records settlement + status", async () => {
    const w = new InMemoryJobStateWriter();
    const p = new EventProcessor(w);
    await p.apply(escrowed("0xj1", 10));
    await p.apply(settled("0xj1", 12));
    expect(w.status.get("0xj1")).toBe(JobStatus.Settled);
    const rec = w.settlements.get("0xj1");
    expect(rec?.operator).toBe(OP);
    expect(rec?.feeUsdc).toBe("25000");
  });

  test("JobRefunded marks failed; FeeCollected records fee", async () => {
    const w = new InMemoryJobStateWriter();
    const p = new EventProcessor(w);
    await p.apply({ kind: "JobRefunded", jobId: "0xj2", buyer: BUYER, amountUsdc: "5000000", blockNumber: 5, logIndex: 0, txHash: "0xtx" });
    expect(w.status.get("0xj2")).toBe(JobStatus.Failed);
    await p.apply({ kind: "FeeCollected", jobId: "0xj1", treasury: TREASURY, amountUsdc: "25000", blockNumber: 6, logIndex: 0, txHash: "0xtx" });
    expect(w.fees.get("0xj1")?.treasury).toBe(TREASURY);
  });

  test("RedundantJobAuthorized persists committee facts without changing status", async () => {
    const w = new InMemoryJobStateWriter();
    const p = new EventProcessor(w);
    await p.apply(escrowed("0xr1", 10)); // JobEscrowed flips status (M0 D4)
    await p.apply({
      kind: "RedundantJobAuthorized", jobId: "0xr1", operatorSetRoot: "0xroot", redundancy: 3,
      bond: "10000000", nonce: 7, blockNumber: 10, logIndex: 1, txHash: "0xtx",
    });
    expect(w.status.get("0xr1")).toBe(JobStatus.Escrowed); // unchanged by authorization
    const auth = w.redundantAuth.get("0xr1");
    expect(auth).toEqual({ operatorSetRoot: "0xroot", redundancy: 3, bond: "10000000", nonce: 7 });
  });

  test("JobConsensus marks proven; ConsensusChallenged marks failed", async () => {
    const w = new InMemoryJobStateWriter();
    const p = new EventProcessor(w);
    await p.apply({
      kind: "JobConsensus", jobId: "0xr1", winningHash: "0xwin", winners: 2,
      rewardPerWinnerUsdc: "49750000", feeUsdc: "500000", blockNumber: 11, logIndex: 0, txHash: "0xtx",
    });
    expect(w.status.get("0xr1")).toBe(JobStatus.Proven);
    await p.apply({ kind: "ConsensusChallenged", jobId: "0xr2", challenger: OP, blockNumber: 12, logIndex: 0, txHash: "0xtx" });
    expect(w.status.get("0xr2")).toBe(JobStatus.Failed);
  });

  test("is idempotent: events at/below the cursor are skipped", async () => {
    const w = new InMemoryJobStateWriter();
    const p = new EventProcessor(w);
    expect(await p.apply(escrowed("0xj1", 10, 2))).toBe(true);
    expect(await p.apply(escrowed("0xj1", 10, 2))).toBe(false); // same position
    expect(await p.apply(escrowed("0xj1", 9, 9))).toBe(false); // earlier block
    expect(await p.apply(escrowed("0xj1", 10, 3))).toBe(true); // later logIndex
  });
});

describe("Indexer.tick", () => {
  test("applies new events in order and advances cursor", async () => {
    const w = new InMemoryJobStateWriter();
    const p = new EventProcessor(w);
    const source = new ArrayLogSource([settled("0xj1", 12), escrowed("0xj1", 10)]); // out of order
    const indexer = new Indexer(source, p, 1);

    const applied = await indexer.tick();
    expect(applied).toBe(2);
    expect(w.status.get("0xj1")).toBe(JobStatus.Settled); // settled applied after escrowed
    expect(p.position()).toEqual({ blockNumber: 12, logIndex: 0 });

    // second tick: nothing new
    expect(await indexer.tick()).toBe(0);
  });
});
