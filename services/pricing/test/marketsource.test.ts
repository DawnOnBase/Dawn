import { describe, expect, test } from "bun:test";
import type { MarketSource } from "../src/app.ts";
import type { MarketState } from "../src/pricing.ts";
import { CachedMarketSource, PostgresMarketSource } from "../src/marketsource.ts";

describe("CachedMarketSource", () => {
  function counting(state: MarketState): { src: MarketSource; calls: () => number } {
    let calls = 0;
    return {
      src: {
        async state() {
          calls++;
          return state;
        },
      },
      calls: () => calls,
    };
  }

  test("caches within the TTL and refetches after it expires", async () => {
    const inner = counting({ openJobs: 3, availableNodes: 2 });
    let clock = 1000;
    const cached = new CachedMarketSource(inner.src, 5000, () => clock);

    expect(await cached.state()).toEqual({ openJobs: 3, availableNodes: 2 });
    expect(inner.calls()).toBe(1);

    clock = 4000; // within TTL
    await cached.state();
    expect(inner.calls()).toBe(1); // served from cache

    clock = 7000; // past TTL (1000 + 5000)
    await cached.state();
    expect(inner.calls()).toBe(2); // refetched
  });
});

// Live integration test against the shared Postgres (read-only). Skipped unless
// DATABASE_URL is set, so CI/local without a DB still passes.
const dsn = process.env.DATABASE_URL;
const dbTest = dsn ? test : test.skip;

describe("PostgresMarketSource (integration)", () => {
  dbTest("returns non-negative integer market counts from the live jobs table", async () => {
    const src = new PostgresMarketSource(dsn!);
    try {
      const state = await src.state();
      expect(Number.isInteger(state.openJobs)).toBe(true);
      expect(state.openJobs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(state.availableNodes)).toBe(true);
      expect(state.availableNodes).toBeGreaterThanOrEqual(0);
    } finally {
      await src.close();
    }
  });
});
