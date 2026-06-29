import { describe, expect, test } from "bun:test";
import { JobStatus } from "@dawn/shared";
import { buildApp, type AppDeps } from "../src/app.ts";
import { InMemoryJobsRepo } from "../src/repo/jobs.ts";
import { StubPaymentVerifier } from "../src/x402.ts";

const BUYER = "0x1111111111111111111111111111111111111111";

function makeApp(repo = new InMemoryJobsRepo()) {
  let n = 0;
  const deps: AppDeps = {
    repo,
    verifier: new StubPaymentVerifier(),
    usdcAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    treasury: "0x2222222222222222222222222222222222222222",
    network: "base-sepolia",
    now: () => 1000,
    nonce: () => `nonce-${n++}`,
  };
  return { app: buildApp(deps), repo };
}

const validBody = {
  buyer: BUYER,
  requirements: { jobType: "general_compute", minCpuCores: 2, estimatedDurationSec: 60 },
  amountUsdc: "5000000",
  deadline: 9000,
  inputRef: "ipfs://input/x",
};

describe("submit + status + result", () => {
  test("submits a job and reads it back", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/jobs", payload: validBody });
    expect(res.statusCode).toBe(201);
    const { jobId, status } = res.json();
    expect(status).toBe("submitted");
    expect(jobId).toMatch(/^0x[0-9a-f]{64}$/);

    const got = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().buyer).toBe(BUYER);
  });

  test("rejects invalid submissions", async () => {
    const { app } = makeApp();
    const bad = await app.inject({ method: "POST", url: "/v1/jobs", payload: { ...validBody, amountUsdc: "0" } });
    expect(bad.statusCode).toBe(400);

    const pastDeadline = await app.inject({ method: "POST", url: "/v1/jobs", payload: { ...validBody, deadline: 10 } });
    expect(pastDeadline.statusCode).toBe(400);

    const badType = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: { ...validBody, requirements: { jobType: "mining", estimatedDurationSec: 60 } },
    });
    expect(badType.statusCode).toBe(400);
  });

  test("duplicate submission is rejected with 409", async () => {
    const { app } = makeApp();
    const body = { ...validBody, nonce: "fixed" };
    expect((await app.inject({ method: "POST", url: "/v1/jobs", payload: body })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/v1/jobs", payload: body })).statusCode).toBe(409);
  });

  test("result reflects readiness", async () => {
    const { app, repo } = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/jobs", payload: { ...validBody, nonce: "r" } });
    const { jobId } = res.json();

    const pending = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}/result` });
    expect(pending.json().ready).toBe(false);

    repo.setResult(jobId, JobStatus.Proven, "ipfs://out/x", "0xabc");
    const ready = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}/result` });
    expect(ready.json().ready).toBe(true);
    expect(ready.json().resultRef).toBe("ipfs://out/x");
    expect(ready.json().attestation.outputHash).toBe("0xabc");
  });

  test("unknown job is 404", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/jobs/0xdead" });
    expect(res.statusCode).toBe(404);
  });
});

describe("x402 flow", () => {
  test("402 without payment header, then 201 with valid payment", async () => {
    const { app } = makeApp();
    const unpaid = await app.inject({ method: "POST", url: "/v1/jobs/x402", payload: { ...validBody, nonce: "x" } });
    expect(unpaid.statusCode).toBe(402);
    expect(unpaid.json().accepts[0].asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");

    const paid = await app.inject({
      method: "POST",
      url: "/v1/jobs/x402",
      headers: { "x-payment": "valid-test-payment" },
      payload: { ...validBody, nonce: "x2" },
    });
    expect(paid.statusCode).toBe(201);
    // D4: escrow status comes only from on-chain JobEscrowed, never from the API.
    expect(paid.json().status).toBe("submitted");
    expect(paid.json().payment.txRef).toBeDefined();
  });

  test("invalid payment stays 402", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/jobs/x402",
      headers: { "x-payment": "nope" },
      payload: { ...validBody, nonce: "x3" },
    });
    expect(res.statusCode).toBe(402);
  });

  test("rejects a replayed payment (same tx funding a second job)", async () => {
    const { app } = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/v1/jobs/x402",
      headers: { "x-payment": "valid-test-payment" },
      payload: { ...validBody, nonce: "rp1" },
    });
    expect(first.statusCode).toBe(201);

    // The stub verifier returns the same txRef; the ledger must reject reusing it.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/jobs/x402",
      headers: { "x-payment": "valid-test-payment" },
      payload: { ...validBody, nonce: "rp2" },
    });
    expect(replay.statusCode).toBe(409);
  });
});
