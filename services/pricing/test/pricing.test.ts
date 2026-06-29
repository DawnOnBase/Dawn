import { describe, expect, test } from "bun:test";
import { buildApp, StaticMarketSource } from "../src/app.ts";
import { demandMultiplier, spotQuote } from "../src/pricing.ts";
import { reliabilityScore } from "../src/reliability.ts";

describe("reliabilityScore", () => {
  test("unknown node is neutral 0.5", () => {
    expect(reliabilityScore({ completed: 0, timedOut: 0, mismatched: 0 })).toBe(0.5);
  });
  test("all-completed trends high", () => {
    expect(reliabilityScore({ completed: 100, timedOut: 0, mismatched: 0 })).toBeGreaterThan(0.95);
  });
  test("mismatches hurt more than timeouts", () => {
    const withTimeouts = reliabilityScore({ completed: 10, timedOut: 5, mismatched: 0 });
    const withMismatches = reliabilityScore({ completed: 10, timedOut: 0, mismatched: 5 });
    expect(withMismatches).toBeLessThan(withTimeouts);
  });
  test("score stays within [0,1]", () => {
    const s = reliabilityScore({ completed: 1, timedOut: 1000, mismatched: 1000 });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("demandMultiplier", () => {
  test("balanced market ~ 1x", () => {
    expect(demandMultiplier({ openJobs: 10, availableNodes: 10 })).toBeCloseTo(1, 5);
  });
  test("excess demand raises price, clamped at 3x", () => {
    expect(demandMultiplier({ openJobs: 100, availableNodes: 1 })).toBe(3);
  });
  test("no nodes => max price", () => {
    expect(demandMultiplier({ openJobs: 5, availableNodes: 0 })).toBe(3);
  });
  test("excess supply lowers price, floored at 0.5x", () => {
    expect(demandMultiplier({ openJobs: 0, availableNodes: 100 })).toBe(0.5);
  });
});

describe("spotQuote", () => {
  test("scales with duration and is an integer string", () => {
    const balanced = { openJobs: 1, availableNodes: 1 };
    const q = spotQuote({ jobType: "general_compute", estimatedDurationSec: 100 }, balanced);
    expect(q.amountUsdc).toMatch(/^[0-9]+$/);
    expect(Number(q.amountUsdc)).toBe(6000); // 60/sec * 1x * 100s
  });
  test("gpu tier adds a premium", () => {
    const balanced = { openJobs: 1, availableNodes: 1 };
    const cpu = Number(spotQuote({ jobType: "inference", estimatedDurationSec: 10 }, balanced).amountUsdc);
    const gpu = Number(spotQuote({ jobType: "inference", estimatedDurationSec: 10, minGpuTier: 2 }, balanced).amountUsdc);
    expect(gpu).toBeGreaterThan(cpu);
  });
});

describe("pricing HTTP", () => {
  test("POST /v1/quote returns a quote", async () => {
    const app = buildApp({ market: new StaticMarketSource({ openJobs: 1, availableNodes: 1 }) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { jobType: "general_compute", estimatedDurationSec: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amountUsdc).toBe("6000");
  });
  test("POST /v1/quote rejects bad input", async () => {
    const app = buildApp({ market: new StaticMarketSource({ openJobs: 1, availableNodes: 1 }) });
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: { jobType: "bogus", estimatedDurationSec: 1 } });
    expect(res.statusCode).toBe(400);
  });
  test("POST /v1/reliability scores stats", async () => {
    const app = buildApp({ market: new StaticMarketSource({ openJobs: 1, availableNodes: 1 }) });
    const res = await app.inject({ method: "POST", url: "/v1/reliability", payload: { completed: 100 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeGreaterThan(0.95);
  });
});
