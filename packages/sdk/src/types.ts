// Public SDK request/response shapes. The on-chain + cross-cutting types
// (`Address`, `Hex`, `Job`, `JobRequirements`, `JobStatus`, …) live in
// `@dawn/shared` and are re-exported from `./index.ts` for convenience.

import type { Address, Hex, Job, JobRequirements } from "@dawn/shared";

export interface DawnClientOptions {
  /** Base URL of the Dawn API, e.g. `https://api.dawn.xyz`. A trailing slash is fine. */
  baseUrl: string;
  /** Override the `fetch` implementation (tests, custom agents). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Headers attached to every request (e.g. an API key). */
  defaultHeaders?: Record<string, string>;
}

export interface SubmitInput {
  buyer: Address;
  requirements: JobRequirements;
  /** USDC base units (6 decimals) as a string — e.g. `"1000000"` = 1.00 USDC. */
  amountUsdc: string;
  /** Unix seconds; must be in the future. */
  deadline: number;
  /** Pointer to the canonical Job Package the node fetches (e.g. `ipfs://…`, `https://…`). */
  inputRef: string;
  /** Optional idempotency nonce; the API generates one if omitted. */
  nonce?: string;
}

export interface SubmitResponse {
  jobId: Hex;
  status: string;
}

export interface PaidSubmitResponse extends SubmitResponse {
  /** The settled x402 payment that backs this job. */
  payment: { txRef: Hex };
}

export interface ResultResponse {
  status: string;
  /** True once the job is `proven` or `settled` and a result is available. */
  ready: boolean;
  /** Pointer to the result payload, once available. */
  resultRef: string | null;
  /** Execution attestation — the signed `outputHash` the contract verified. */
  attestation: { outputHash: Hex } | null;
}

/** One x402 payment option the API will accept (the `402` challenge body). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: Address;
  payTo: Address;
  maxAmountRequired: string;
  resource: string;
}

export interface WaitOptions {
  /** Poll interval in ms (default 2000). */
  intervalMs?: number;
  /** Give up after this many ms (default 120000). */
  timeoutMs?: number;
  /** Abort the wait early. */
  signal?: AbortSignal;
}

export type { Job };
