# @dawn/sdk

The TypeScript SDK for **Dawn** — submit compute jobs, poll for results, and pay per job
in USDC. A thin, dependency-free typed wrapper over the [Dawn API](../../services/api)
. Runs anywhere `fetch` exists (Node ≥18, Bun, Deno, browsers, edge runtimes).

> **Status:** the protocol is live on **Base Sepolia testnet**. Point `baseUrl` at your Dawn
> API deployment.

## Install

This package lives in the Dawn monorepo and ships as TypeScript source (consumed via the
workspace `@dawn/sdk` alias). To use it standalone, copy `src/` or publish it with a build step
(`tsc`); its only peer dependency is [`@dawn/shared`](../shared) for the shared type definitions.

## Quickstart — submit a job and wait for the result

```ts
import { DawnClient } from "@dawn/sdk";

const dawn = new DawnClient({ baseUrl: "https://api.your-dawn-deployment.xyz" });

// Submit a job (the buyer must have escrowed USDC on the Settlement contract).
const { jobId } = await dawn.submit({
  buyer: "0xYourBuyerAddress",
  requirements: { jobType: "general_compute", estimatedDurationSec: 30 },
  amountUsdc: "1000000",          // 1.00 USDC, in base units (6 decimals)
  deadline: Math.floor(Date.now() / 1000) + 3600,
  inputRef: "ipfs://Qm…",          // the canonical Job Package the node fetches
});

// Poll until the job is proven/settled (default: every 2s, up to 2 min).
const result = await dawn.waitForResult(jobId, { intervalMs: 3000, timeoutMs: 120_000 });

console.log(result.resultRef);              // pointer to the output payload
console.log(result.attestation?.outputHash); // the signed outputHash the contract verified
```

Or in one call:

```ts
const result = await dawn.submitAndWait({ /* …SubmitInput… */ });
```

## AI agents — pay inline with x402

Agents can pay per request without a pre-funded escrow, using the
[x402](https://www.x402.org/) payment protocol:

```ts
// 1. Ask the API what payment it requires (the 402 challenge).
const [requirements] = await dawn.quotePayment(input);

// 2. Construct & settle the payment, producing the X-PAYMENT header value
//    (e.g. with an x402 client / wallet).
const paymentHeader = await pay(requirements);

// 3. Submit with the settled payment.
const { jobId, payment } = await dawn.submitWithPayment(input, paymentHeader);
console.log(payment.txRef); // the on-chain tx backing this job
```

## API

| Method | HTTP | Returns |
|--------|------|---------|
| `health()` | `GET /healthz` | `{ status }` |
| `submit(input)` | `POST /v1/jobs` | `{ jobId, status }` |
| `status(jobId)` | `GET /v1/jobs/:id` | `Job` |
| `result(jobId)` | `GET /v1/jobs/:id/result` | `{ status, ready, resultRef, attestation }` |
| `waitForResult(jobId, opts?)` | polls `result` | ready `ResultResponse` |
| `submitAndWait(input, opts?)` | `submit` + poll | ready `ResultResponse` |
| `quotePayment(input)` | `POST /v1/jobs/x402` (no header) | `PaymentRequirements[]` |
| `submitWithPayment(input, header)` | `POST /v1/jobs/x402` | `{ jobId, status, payment }` |

### Options

```ts
new DawnClient({
  baseUrl: "https://…",            // required
  fetch: customFetch,              // optional — defaults to globalThis.fetch
  defaultHeaders: { "x-api-key" }, // optional — attached to every request
});
```

`waitForResult` / `submitAndWait` accept `{ intervalMs, timeoutMs, signal }` — pass an
`AbortSignal` to cancel a wait.

### Errors

All rejections are typed:

- **`DawnApiError`** — any non-2xx response; carries `.status` and `.body`.
- **`DawnPaymentRequiredError`** (extends `DawnApiError`) — a `402`; carries `.accepts: PaymentRequirements[]`.
- **`DawnJobFailedError`** — the job reached `failed` / `timed_out` while waiting; carries `.status`.
- **`DawnTimeoutError`** — `waitForResult` exceeded its `timeoutMs`.
- **`DawnAbortError`** — the provided `AbortSignal` fired.

```ts
import { DawnApiError, DawnTimeoutError } from "@dawn/sdk";

try {
  await dawn.submitAndWait(input, { timeoutMs: 60_000 });
} catch (e) {
  if (e instanceof DawnTimeoutError) {/* still running — keep polling later */}
  else if (e instanceof DawnApiError) {/* e.status, e.body */}
  else throw e;
}
```

## Develop

```sh
bun test         # run the test suite
bun run typecheck
```
