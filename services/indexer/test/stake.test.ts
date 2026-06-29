import { describe, expect, test } from "bun:test";
import type { Address } from "@dawn/shared";
import type { Cursor } from "../src/events.ts";
import { mapDecodedStakeLog } from "../src/rpcstakesource.ts";
import { InMemoryStakeStateWriter, StakeIndexer, StakeProcessor, type StakeEvent } from "../src/stake.ts";

const OP = "0x1111111111111111111111111111111111111111" as Address;

function ev(kind: StakeEvent["kind"], extra: Record<string, unknown>, block: number, logIndex = 0): StakeEvent {
  return { kind, operator: OP, blockNumber: block, logIndex, txHash: "0xtx", ...extra } as unknown as StakeEvent;
}

describe("StakeProcessor", () => {
  test("Staked re-anchors free; Locked/Released move between free and locked", async () => {
    const w = new InMemoryStakeStateWriter();
    const p = new StakeProcessor(w);
    await p.apply(ev("Staked", { amount: "50000000", newFree: "50000000" }, 10));
    expect(w.balances.get(OP)).toEqual({ free: 50_000_000n, locked: 0n });

    await p.apply(ev("Locked", { amount: "10000000" }, 11)); // bond a job
    expect(w.balances.get(OP)).toEqual({ free: 40_000_000n, locked: 10_000_000n });

    await p.apply(ev("Released", { amount: "10000000" }, 12)); // job done, bond returned
    expect(w.balances.get(OP)).toEqual({ free: 50_000_000n, locked: 0n });
  });

  test("Slashed burns locked; Withdrawn removes free; floored at zero", async () => {
    const w = new InMemoryStakeStateWriter();
    const p = new StakeProcessor(w);
    await p.apply(ev("Staked", { amount: "50000000", newFree: "50000000" }, 1));
    await p.apply(ev("Locked", { amount: "10000000" }, 2));
    await p.apply(ev("Slashed", { amount: "10000000" }, 3)); // lose the bond
    expect(w.balances.get(OP)).toEqual({ free: 40_000_000n, locked: 0n });

    await p.apply(ev("Withdrawn", { amount: "999999999" }, 4)); // over-withdraw floors at 0, never negative
    expect(w.balances.get(OP)!.free).toBe(0n);
  });

  test("is idempotent past the cursor", async () => {
    const w = new InMemoryStakeStateWriter();
    const p = new StakeProcessor(w);
    expect(await p.apply(ev("Staked", { amount: "1", newFree: "1" }, 5, 1))).toBe(true);
    expect(await p.apply(ev("Staked", { amount: "1", newFree: "1" }, 5, 1))).toBe(false); // same position
    expect(await p.apply(ev("Staked", { amount: "1", newFree: "1" }, 4, 9))).toBe(false); // earlier block
  });
});

describe("mapDecodedStakeLog", () => {
  test("decodes Staked + ignores untracked events", () => {
    const staked = mapDecodedStakeLog({
      eventName: "Staked",
      args: { operator: OP, amount: 7n, newFree: 7n },
      blockNumber: 1,
      logIndex: 0,
      txHash: "0xtx",
    });
    expect(staked).toEqual({ kind: "Staked", operator: OP, amount: "7", newFree: "7", blockNumber: 1, logIndex: 0, txHash: "0xtx" });
    expect(mapDecodedStakeLog({ eventName: "SlasherSet", args: {}, blockNumber: 1, logIndex: 1, txHash: "0xtx" })).toBeNull();
  });
});

describe("StakeIndexer", () => {
  test("applies events from a source and advances its own cursor", async () => {
    const w = new InMemoryStakeStateWriter();
    const p = new StakeProcessor(w);
    const events = [ev("Staked", { amount: "5", newFree: "5" }, 10), ev("Locked", { amount: "2" }, 11)];
    const saved: Cursor[] = [];
    const cursor = {
      loadStake: async () => null,
      saveStake: async (c: Cursor) => {
        saved.push(c);
      },
    };
    const idx = new StakeIndexer({ fetch: async () => events }, p, 1, cursor);

    expect(await idx.tick()).toBe(2);
    expect(w.balances.get(OP)).toEqual({ free: 3n, locked: 2n });
    expect(saved[0]).toEqual({ blockNumber: 11, logIndex: 0 });
  });
});
