import { describe, expect, test } from "bun:test";
import { JobStatus } from "@dawn/shared";
import type { Address, Hex } from "@dawn/shared";
import {
  DawnAbortError,
  DawnApiError,
  DawnClient,
  DawnJobFailedError,
  DawnPaymentRequiredError,
  DawnTimeoutError,
  type PaymentRequirements,
  type SubmitInput,
} from "../src/index.ts";

const BASE = "http://api.test";
const JOB_ID = ("0x" + "11".repeat(32)) as Hex;
const BUYER = ("0x" + "22".repeat(20)) as Address;
const TX = ("0x" + "ab".repeat(32)) as Hex;

function input(): SubmitInput {
  return {
    buyer: BUYER,
    requirements: { jobType: "general_compute", estimatedDurationSec: 10 },
    amountUsdc: "1000000",
    deadline: 9_999_999_999,
    inputRef: "ipfs://Qmexample",
  };
}

function res(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => text,
  } as Response;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: unknown, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const notReady = () =>
  res(200, { status: JobStatus.Running, ready: false, resultRef: null, attestation: null });
const ready = () =>
  res(200, { status: JobStatus.Settled, ready: true, resultRef: "ipfs://out", attestation: { outputHash: "0xabc" } });

describe("DawnClient core requests", () => {
  test("submit posts to /v1/jobs and returns the created job", async () => {
    const { fn, calls } = stub(() => res(201, { jobId: JOB_ID, status: "escrowed" }));
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    const r = await c.submit(input());
    expect(r).toEqual({ jobId: JOB_ID, status: "escrowed" });
    expect(calls[0]!.url).toBe(BASE + "/v1/jobs");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toMatchObject({ buyer: BUYER, amountUsdc: "1000000" });
  });

  test("status and result GET the right paths", async () => {
    const { fn, calls } = stub((call) =>
      call.url.endsWith("/result") ? ready() : res(200, { jobId: JOB_ID, status: "running", buyer: BUYER }),
    );
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    await c.status(JOB_ID);
    await c.result(JOB_ID);
    expect(calls[0]!.url).toBe(`${BASE}/v1/jobs/${JOB_ID}`);
    expect(calls[1]!.url).toBe(`${BASE}/v1/jobs/${JOB_ID}/result`);
  });

  test("a trailing slash on baseUrl is normalized", async () => {
    const { fn, calls } = stub(() => res(200, { status: "ok" }));
    const c = new DawnClient({ baseUrl: BASE + "/", fetch: fn });
    await c.health();
    expect(calls[0]!.url).toBe(BASE + "/healthz");
  });

  test("accepts a bare baseUrl string", async () => {
    const { fn } = stub(() => res(200, { status: "ok" }));
    const c = new DawnClient(BASE);
    // swap the fetch by constructing with options instead; bare-string path just must not throw
    expect(c).toBeInstanceOf(DawnClient);
    void fn;
  });
});

describe("error mapping", () => {
  test("a 400 throws DawnApiError carrying status + message", async () => {
    const { fn } = stub(() => res(400, { error: "deadline must be a future unix timestamp" }));
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    try {
      await c.submit(input());
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DawnApiError);
      expect((e as DawnApiError).status).toBe(400);
      expect((e as DawnApiError).message).toBe("deadline must be a future unix timestamp");
    }
  });

  test("a 409 duplicate throws DawnApiError(409)", async () => {
    const { fn } = stub(() => res(409, { error: "duplicate job" }));
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    await expect(c.submit(input())).rejects.toBeInstanceOf(DawnApiError);
  });

  test("a 402 on a normal path throws DawnPaymentRequiredError with accepts", async () => {
    const accepts: PaymentRequirements[] = [
      { scheme: "exact", network: "base-sepolia", asset: BUYER, payTo: BUYER, maxAmountRequired: "1000000", resource: "x" },
    ];
    const { fn } = stub(() => res(402, { accepts }));
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    try {
      await c.status(JOB_ID);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DawnPaymentRequiredError);
      expect((e as DawnPaymentRequiredError).accepts).toEqual(accepts);
    }
  });
});

describe("waitForResult", () => {
  test("polls until ready", async () => {
    let n = 0;
    const { fn } = stub(() => {
      n++;
      return n < 3 ? notReady() : ready();
    });
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    const r = await c.waitForResult(JOB_ID, { intervalMs: 1, timeoutMs: 1_000 });
    expect(r.ready).toBe(true);
    expect(r.resultRef).toBe("ipfs://out");
    expect(n).toBe(3);
  });

  test("throws DawnTimeoutError when never ready", async () => {
    const { fn } = stub(() => notReady());
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    await expect(c.waitForResult(JOB_ID, { intervalMs: 2, timeoutMs: 5 })).rejects.toBeInstanceOf(DawnTimeoutError);
  });

  test("throws DawnJobFailedError on a terminal failure status", async () => {
    const { fn } = stub(() => res(200, { status: JobStatus.Failed, ready: false, resultRef: null, attestation: null }));
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    await expect(c.waitForResult(JOB_ID, { intervalMs: 1, timeoutMs: 1_000 })).rejects.toBeInstanceOf(DawnJobFailedError);
  });

  test("respects an already-aborted signal", async () => {
    const { fn, calls } = stub(() => notReady());
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    const ac = new AbortController();
    ac.abort();
    await expect(c.waitForResult(JOB_ID, { signal: ac.signal })).rejects.toBeInstanceOf(DawnAbortError);
    expect(calls.length).toBe(0);
  });

  test("submitAndWait composes submit + poll", async () => {
    let submitted = false;
    const { fn } = stub((call) => {
      if (call.url.endsWith("/v1/jobs")) {
        submitted = true;
        return res(201, { jobId: JOB_ID, status: "escrowed" });
      }
      return ready();
    });
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    const r = await c.submitAndWait(input(), { intervalMs: 1, timeoutMs: 1_000 });
    expect(submitted).toBe(true);
    expect(r.ready).toBe(true);
  });
});

describe("x402", () => {
  test("quotePayment returns the accepts from a 402 challenge", async () => {
    const accepts: PaymentRequirements[] = [
      { scheme: "exact", network: "base-sepolia", asset: BUYER, payTo: BUYER, maxAmountRequired: "1000000", resource: "POST /v1/jobs/x402" },
    ];
    const { fn, calls } = stub((call) =>
      call.headers["x-payment"] ? res(201, { jobId: JOB_ID, status: "submitted" }) : res(402, { accepts }),
    );
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    const got = await c.quotePayment(input());
    expect(got).toEqual(accepts);
    expect(calls[0]!.url).toBe(BASE + "/v1/jobs/x402");
    expect(calls[0]!.headers["x-payment"]).toBeUndefined();
  });

  test("submitWithPayment sends the X-PAYMENT header and returns the payment ref", async () => {
    const { fn, calls } = stub(() => res(201, { jobId: JOB_ID, status: "submitted", payment: { txRef: TX } }));
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    const r = await c.submitWithPayment(input(), "PAYHEADER");
    expect(r.payment.txRef).toBe(TX);
    expect(calls[0]!.headers["x-payment"]).toBe("PAYHEADER");
  });

  test("submitWithPayment surfaces a 402 as DawnPaymentRequiredError", async () => {
    const accepts: PaymentRequirements[] = [
      { scheme: "exact", network: "base-sepolia", asset: BUYER, payTo: BUYER, maxAmountRequired: "1000000", resource: "r" },
    ];
    const { fn } = stub(() => res(402, { error: "payment failed", accepts }));
    const c = new DawnClient({ baseUrl: BASE, fetch: fn });
    try {
      await c.submitWithPayment(input(), "BADHEADER");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DawnPaymentRequiredError);
      expect((e as DawnPaymentRequiredError).accepts).toEqual(accepts);
    }
  });
});
