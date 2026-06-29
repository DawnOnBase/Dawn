import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "@dawn/shared";
import type { DecodedSettlementLog } from "@dawn/shared/web3";
import { mapDecodedLog, RpcLogSource } from "../src/rpcsource.ts";
import type { SettlementEvent } from "../src/events.ts";

const JOB = ("0x" + "11".repeat(32)) as Hex;
const BUYER = "0x1111111111111111111111111111111111111111" as Address;
const OPERATOR = "0x2222222222222222222222222222222222222222" as Address;
const TREASURY = "0x3333333333333333333333333333333333333333" as Address;

function decoded(eventName: string, args: Record<string, unknown>, blockNumber: number, logIndex = 0): DecodedSettlementLog {
  return { eventName, args, blockNumber, logIndex, txHash: ("0x" + "ab".repeat(32)) as Hex };
}

describe("mapDecodedLog", () => {
  test("maps JobEscrowed", () => {
    const ev = mapDecodedLog(decoded("JobEscrowed", { jobId: JOB, buyer: BUYER, amount: 1000n, deadline: 99n }, 10), undefined);
    expect(ev).toEqual({
      kind: "JobEscrowed",
      jobId: JOB,
      buyer: BUYER,
      amountUsdc: "1000",
      deadline: 99,
      blockNumber: 10,
      logIndex: 0,
      txHash: ("0x" + "ab".repeat(32)) as Hex,
    });
  });

  test("maps JobSettled with payout + fee", () => {
    const ev = mapDecodedLog(decoded("JobSettled", { jobId: JOB, operator: OPERATOR, payout: 995n, fee: 5n }, 12), undefined) as Extract<SettlementEvent, { kind: "JobSettled" }>;
    expect(ev.kind).toBe("JobSettled");
    expect(ev.operator).toBe(OPERATOR);
    expect(ev.amountUsdc).toBe("995");
    expect(ev.feeUsdc).toBe("5");
  });

  test("maps JobRefunded", () => {
    const ev = mapDecodedLog(decoded("JobRefunded", { jobId: JOB, buyer: BUYER, amount: 1000n }, 13), undefined);
    expect(ev?.kind).toBe("JobRefunded");
  });

  test("maps FeeCollected only when treasury is supplied", () => {
    const log = decoded("FeeCollected", { jobId: JOB, fee: 5n }, 14);
    expect(mapDecodedLog(log, undefined)).toBeNull();
    const ev = mapDecodedLog(log, TREASURY) as Extract<SettlementEvent, { kind: "FeeCollected" }>;
    expect(ev.treasury).toBe(TREASURY);
    expect(ev.amountUsdc).toBe("5");
  });

  test("ignores untracked events (bonds, consensus, proofs)", () => {
    expect(mapDecodedLog(decoded("BondSlashed", { jobId: JOB, operator: OPERATOR, bond: 1n }, 15), undefined)).toBeNull();
    expect(mapDecodedLog(decoded("ProofSubmitted", { jobId: JOB, operator: OPERATOR, outputHash: JOB }, 16), undefined)).toBeNull();
  });
});

describe("RpcLogSource.fetch", () => {
  const baseCfg = { chainId: 84532 as const, address: "0xc27C681cE93a63C0987226CDaC7b66232018651E" as Address, deployBlock: 100n, confirmations: 2n, maxBlockRange: 50n };

  test("scans from the deploy block on a cold start and maps events", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const src = new RpcLogSource(baseCfg, {
      headFn: async () => 120n, // head 120 -> toBlock 118
      logFetcher: async (from, to) => {
        ranges.push([from, to]);
        if (from <= 110n && to >= 110n) return [decoded("JobEscrowed", { jobId: JOB, buyer: BUYER, amount: 1000n, deadline: 99n }, 110)];
        return [];
      },
      treasuryFn: async () => TREASURY,
    });

    const events = await src.fetch(null);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("JobEscrowed");
    // cold start scans [100,118], chunked at range 50 -> [100,150]∩ => single chunk [100,118]
    expect(ranges[0]).toEqual([100n, 118n]);
  });

  test("returns nothing until head is past the confirmation margin", async () => {
    const src = new RpcLogSource(baseCfg, {
      headFn: async () => 1n, // toBlock = -1
      logFetcher: async () => [decoded("JobEscrowed", { jobId: JOB, buyer: BUYER, amount: 1n, deadline: 9n }, 0)],
      treasuryFn: async () => TREASURY,
    });
    expect(await src.fetch(null)).toEqual([]);
  });

  test("resumes after the cursor, filtering events at/below it", async () => {
    const src = new RpcLogSource(baseCfg, {
      headFn: async () => 220n,
      logFetcher: async (from) => {
        // The cursor block (200) is re-scanned; both its old and a new log returned.
        if (from <= 200n) {
          return [
            decoded("JobEscrowed", { jobId: JOB, buyer: BUYER, amount: 1n, deadline: 9n }, 200, 0), // at cursor -> filtered
            decoded("JobSettled", { jobId: JOB, operator: OPERATOR, payout: 9n, fee: 1n }, 200, 1), // after cursor -> kept
          ];
        }
        return [];
      },
      treasuryFn: async () => TREASURY,
    });

    const events = await src.fetch({ blockNumber: 200, logIndex: 0 });
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("JobSettled");
    expect(events[0]!.logIndex).toBe(1);
  });

  test("does not re-scan already-swept empty ranges on the next poll", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    let head = 118n;
    const src = new RpcLogSource(baseCfg, {
      headFn: async () => head,
      logFetcher: async (from, to) => {
        ranges.push([from, to]);
        return [];
      },
      treasuryFn: async () => TREASURY,
    });
    // Poll 1: cold start sweeps [100,116] (head 118 − 2 conf), no events → cursor stays null.
    await src.fetch(null);
    // Poll 2: head advanced; must sweep ONLY the new blocks, not re-scan from deploy (100).
    head = 122n;
    ranges.length = 0;
    await src.fetch(null);
    expect(ranges).toEqual([[117n, 120n]]);
  });

  test("chunks large ranges across multiple getLogs calls", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const src = new RpcLogSource({ ...baseCfg, deployBlock: 0n, maxBlockRange: 50n }, {
      headFn: async () => 122n, // toBlock 120 -> chunks [0,50],[51,101],[102,120]
      logFetcher: async (from, to) => {
        ranges.push([from, to]);
        return [];
      },
      treasuryFn: async () => TREASURY,
    });
    await src.fetch(null);
    expect(ranges).toEqual([
      [0n, 50n],
      [51n, 101n],
      [102n, 120n],
    ]);
  });

  test("reads treasury once and caches it across FeeCollected events", async () => {
    let treasuryReads = 0;
    const src = new RpcLogSource(baseCfg, {
      headFn: async () => 120n,
      logFetcher: async () => [
        decoded("FeeCollected", { jobId: JOB, fee: 5n }, 110, 0),
        decoded("FeeCollected", { jobId: JOB, fee: 7n }, 111, 0),
      ],
      treasuryFn: async () => {
        treasuryReads++;
        return TREASURY;
      },
    });
    const events = await src.fetch(null);
    expect(events.length).toBe(2);
    expect(treasuryReads).toBe(1);
  });
});
