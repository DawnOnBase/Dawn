import type { Hex } from "@dawn/shared";
import type { PaymentRequirements } from "./types.ts";

/** Any non-2xx response from the Dawn API. */
export class DawnApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The parsed response body, when present. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "DawnApiError";
  }
}

/** A `402 Payment Required` — carries the x402 options the API will accept. */
export class DawnPaymentRequiredError extends DawnApiError {
  constructor(
    public readonly accepts: PaymentRequirements[],
    message = "payment required",
    body?: unknown,
  ) {
    super(402, message, body);
    this.name = "DawnPaymentRequiredError";
  }
}

/** `waitForResult` exceeded its timeout before the job became ready. */
export class DawnTimeoutError extends Error {
  constructor(
    public readonly jobId: Hex,
    public readonly timeoutMs: number,
  ) {
    super(`waitForResult timed out after ${timeoutMs}ms for job ${jobId}`);
    this.name = "DawnTimeoutError";
  }
}

/** The job reached a terminal failure state (`failed` / `timed_out`) while waiting. */
export class DawnJobFailedError extends Error {
  constructor(
    public readonly jobId: Hex,
    public readonly status: string,
  ) {
    super(`job ${jobId} ended in terminal status "${status}"`);
    this.name = "DawnJobFailedError";
  }
}

/** The caller's `AbortSignal` fired. */
export class DawnAbortError extends Error {
  constructor() {
    super("operation aborted");
    this.name = "DawnAbortError";
  }
}
