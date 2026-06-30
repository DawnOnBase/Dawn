// Dawn buyer SDK  — a thin, dependency-free typed wrapper over
// the Dawn API. Submit a job, poll until it's proven, fetch the result + the
// signed execution attestation. AI agents can pay inline via x402.

import { JobStatus } from "@dawn/shared";
import type { Hex, Job } from "@dawn/shared";
import {
  DawnAbortError,
  DawnApiError,
  DawnJobFailedError,
  DawnPaymentRequiredError,
  DawnTimeoutError,
} from "./errors.ts";
import type {
  DawnClientOptions,
  PaidSubmitResponse,
  PaymentRequirements,
  ResultResponse,
  SubmitInput,
  SubmitResponse,
  WaitOptions,
} from "./types.ts";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export class DawnClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: DawnClientOptions | string) {
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    // Strip trailing slashes so `baseUrl + "/v1/…"` never double-slashes.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    if (!this.baseUrl) throw new Error("DawnClient: baseUrl is required");
    if (typeof this.fetchImpl !== "function") {
      throw new Error("DawnClient: no fetch implementation available (pass options.fetch)");
    }
  }

  /** Liveness check — `GET /healthz`. */
  health(): Promise<{ status: string }> {
    return this.json("GET", "/healthz");
  }

  /** Submit a job for on-chain-escrowed execution — `POST /v1/jobs`. */
  submit(input: SubmitInput): Promise<SubmitResponse> {
    return this.json("POST", "/v1/jobs", input);
  }

  /** Fetch current job state — `GET /v1/jobs/:id`. */
  status(jobId: Hex): Promise<Job> {
    return this.json("GET", `/v1/jobs/${jobId}`);
  }

  /** Fetch the result + attestation (may not be ready yet) — `GET /v1/jobs/:id/result`. */
  result(jobId: Hex): Promise<ResultResponse> {
    return this.json("GET", `/v1/jobs/${jobId}/result`);
  }

  /**
   * Poll `result(jobId)` until the job is ready, throwing on terminal failure,
   * timeout, or abort. Returns the ready {@link ResultResponse}.
   */
  async waitForResult(jobId: Hex, options: WaitOptions = {}): Promise<ResultResponse> {
    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { signal } = options;
    const deadline = Date.now() + timeout;

    for (;;) {
      if (signal?.aborted) throw new DawnAbortError();
      const r = await this.result(jobId);
      if (r.ready) return r;
      if (r.status === JobStatus.Failed || r.status === JobStatus.TimedOut) {
        throw new DawnJobFailedError(jobId, r.status);
      }
      if (Date.now() + interval >= deadline) throw new DawnTimeoutError(jobId, timeout);
      await delay(interval, signal);
    }
  }

  /** Convenience: {@link submit} then {@link waitForResult}. */
  async submitAndWait(input: SubmitInput, options?: WaitOptions): Promise<ResultResponse> {
    const { jobId } = await this.submit(input);
    return this.waitForResult(jobId, options);
  }

  /**
   * x402: ask the API what payment it requires for this job (the `402` challenge).
   * Returns the accepted payment options to construct an `X-PAYMENT` header from.
   */
  async quotePayment(input: SubmitInput): Promise<PaymentRequirements[]> {
    const res = await this.raw("POST", "/v1/jobs/x402", input);
    const body = await parseBody(res);
    if (res.status === 402 && Array.isArray(body?.accepts)) {
      return body.accepts as PaymentRequirements[];
    }
    if (res.ok) {
      throw new DawnApiError(res.status, "expected a 402 payment challenge but the job was created", body);
    }
    throw new DawnApiError(res.status, errorMessage(body, res.statusText), body);
  }

  /** x402: submit a job with a settled payment — the `X-PAYMENT` header value. */
  async submitWithPayment(input: SubmitInput, paymentHeader: string): Promise<PaidSubmitResponse> {
    const res = await this.raw("POST", "/v1/jobs/x402", input, { "x-payment": paymentHeader });
    const body = await parseBody(res);
    if (res.ok) return body as PaidSubmitResponse;
    if (res.status === 402) {
      throw new DawnPaymentRequiredError(
        (body?.accepts ?? []) as PaymentRequirements[],
        errorMessage(body, "payment required"),
        body,
      );
    }
    throw new DawnApiError(res.status, errorMessage(body, res.statusText), body);
  }

  private async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await this.raw(method, path, body, headers);
    const parsed = await parseBody(res);
    if (!res.ok) {
      if (res.status === 402) {
        throw new DawnPaymentRequiredError(
          (parsed?.accepts ?? []) as PaymentRequirements[],
          errorMessage(parsed, "payment required"),
          parsed,
        );
      }
      throw new DawnApiError(res.status, errorMessage(parsed, res.statusText), parsed);
    }
    return parsed as T;
  }

  private raw(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
    return this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...this.defaultHeaders,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DawnAbortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DawnAbortError());
      },
      { once: true },
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return fallback;
}
