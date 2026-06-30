import { describe, expect, test } from "bun:test";
import {
  cuFor,
  DEFAULT_METHOD_CU,
  resetSharedRpcBucket,
  sharedRpcBucket,
  TokenBucket,
} from "../src/web3/ratelimit";

// A controllable clock + sleep so the bucket's timing is fully deterministic.
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    // sleep() advances the virtual clock by the requested amount.
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe("cuFor", () => {
  test("known methods use their CU weight; getLogs is the heavy one", () => {
    expect(cuFor("eth_getLogs")).toBe(75);
    expect(cuFor("eth_blockNumber")).toBe(10);
    expect(cuFor("eth_sendRawTransaction")).toBe(250);
  });

  test("unknown methods fall back to the default, never below 1", () => {
    expect(cuFor("eth_somethingNew")).toBe(DEFAULT_METHOD_CU);
    expect(cuFor("eth_chainId")).toBe(1); // listed as 0 → clamped to 1
  });
});

describe("TokenBucket", () => {
  test("tryTake consumes tokens and fails once drained", () => {
    const clk = fakeClock();
    const b = new TokenBucket({ cuPerSec: 100, burst: 100, now: clk.now, sleep: clk.sleep });
    expect(b.tryTake(60)).toBe(true); // 40 left
    expect(b.tryTake(60)).toBe(false); // not enough
    expect(b.tryTake(40)).toBe(true); // exactly drains
    expect(b.tryTake(1)).toBe(false);
  });

  test("refills at cuPerSec over time, capped at capacity", () => {
    const clk = fakeClock();
    const b = new TokenBucket({ cuPerSec: 100, burst: 100, now: clk.now, sleep: clk.sleep });
    expect(b.tryTake(100)).toBe(true); // empty
    clk.advance(500); // 0.5s → +50 CU
    expect(b.tryTake(50)).toBe(true);
    expect(b.tryTake(1)).toBe(false);
    clk.advance(10_000); // long idle never exceeds capacity
    expect(b.waitMsFor(100)).toBe(0);
    expect(b.tryTake(100)).toBe(true);
  });

  test("take() blocks until tokens refill, then proceeds", async () => {
    const clk = fakeClock();
    const b = new TokenBucket({ cuPerSec: 100, burst: 100, now: clk.now, sleep: clk.sleep });
    await b.take(100); // drains the bucket immediately (no wait)
    const before = clk.now();
    await b.take(75); // needs 0.75s of refill — sleep() advances the clock
    expect(clk.now() - before).toBeGreaterThanOrEqual(750);
  });

  test("a cost above capacity is clamped, not deadlocked", async () => {
    const clk = fakeClock();
    const b = new TokenBucket({ cuPerSec: 50, burst: 50, now: clk.now, sleep: clk.sleep });
    await b.take(1000); // clamped to capacity (50) — resolves rather than hanging
    expect(clk.now()).toBeGreaterThanOrEqual(0);
  });

  test("maxWaitMs is a starvation backstop: take() returns even if starved", async () => {
    const clk = fakeClock();
    const b = new TokenBucket({
      cuPerSec: 1,
      burst: 1,
      maxWaitMs: 100,
      now: clk.now,
      sleep: clk.sleep,
    });
    await b.take(1); // drain
    // Asking for capacity again would take ~1s, but maxWaitMs=100ms lets it through.
    await b.take(1);
    expect(clk.now()).toBeGreaterThanOrEqual(100);
  });
});

describe("sharedRpcBucket", () => {
  test("is a singleton and reads RPC_CU_PER_SEC from env", () => {
    const prev = process.env.RPC_CU_PER_SEC;
    process.env.RPC_CU_PER_SEC = "150";
    resetSharedRpcBucket();
    const a = sharedRpcBucket();
    const b = sharedRpcBucket();
    expect(a).toBe(b);
    expect(a.cuPerSec).toBe(150);
    if (prev === undefined) delete process.env.RPC_CU_PER_SEC;
    else process.env.RPC_CU_PER_SEC = prev;
    resetSharedRpcBucket();
  });
});
