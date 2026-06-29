// Fastify app . Buyers submit jobs, poll status, and
// fetch results + attestation; AI agents can pay inline via x402. Built as a
// factory so tests drive it with `app.inject()` (no port, no infra).

import Fastify, { type FastifyInstance } from "fastify";
import type { Address, Hex, JobRequirements, JobType } from "@dawn/shared";
import { JobStatus } from "@dawn/shared";
import { computeJobId } from "./jobid.ts";
import { DuplicateJobError, PaymentReusedError, type JobsRepo } from "./repo/jobs.ts";
import type { PaymentRequirements, PaymentVerifier } from "./x402.ts";

const JOB_TYPES: ReadonlySet<string> = new Set([
  "inference",
  "data_processing",
  "rendering",
  "fine_tune_shard",
  "general_compute",
]);

export interface AppDeps {
  repo: JobsRepo;
  verifier: PaymentVerifier;
  usdcAsset: Address;
  treasury: Address;
  network: "base" | "base-sepolia";
  now?: () => number; // unix seconds; injectable for tests
  nonce?: () => string; // injectable for deterministic tests
}

interface SubmitBody {
  buyer?: string;
  requirements?: Partial<JobRequirements>;
  amountUsdc?: string;
  deadline?: number;
  inputRef?: string;
  nonce?: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const nonce = deps.nonce ?? (() => crypto.randomUUID());
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/v1/jobs", async (req, reply) => {
    const body = (req.body ?? {}) as SubmitBody;
    const v = validateSubmit(body, now());
    if (!v.ok) return reply.code(400).send({ error: v.error });

    const jobId = computeJobId({
      buyer: v.buyer,
      requirements: v.requirements,
      amountUsdc: v.amountUsdc,
      deadline: v.deadline,
      nonce: body.nonce ?? nonce(),
    });

    try {
      const job = await deps.repo.create({
        jobId,
        buyer: v.buyer,
        requirements: v.requirements,
        amountUsdc: v.amountUsdc,
        deadline: v.deadline,
        inputRef: v.inputRef,
      });
      return reply.code(201).send({ jobId: job.jobId, status: job.status });
    } catch (err) {
      if (err instanceof DuplicateJobError) return reply.code(409).send({ error: "duplicate job" });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req, reply) => {
    const job = await deps.repo.get(req.params.id as Hex);
    if (!job) return reply.code(404).send({ error: "not found" });
    return reply.send(job);
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id/result", async (req, reply) => {
    const result = await deps.repo.result(req.params.id as Hex);
    if (!result) return reply.code(404).send({ error: "not found" });
    const ready = result.status === JobStatus.Proven || result.status === JobStatus.Settled;
    return reply.send({
      status: result.status,
      ready,
      resultRef: result.resultRef ?? null,
      attestation: result.outputHash ? { outputHash: result.outputHash } : null,
    });
  });

  // x402: no payment header -> 402 with requirements; with a valid header -> consume
  // the payment (non-replayable) and create the job. Per a design decision the payment
  // pays the treasury, NOT the escrow contract, so the job is NOT on-chain-escrowed
  // here — it enters `submitted`; the relayer that drives on-chain escrow() for an
  // x402 buyer is M10. Until then x402 jobs are recorded but not yet claimable.
  app.post("/v1/jobs/x402", async (req, reply) => {
    const body = (req.body ?? {}) as SubmitBody;
    const v = validateSubmit(body, now());
    if (!v.ok) return reply.code(400).send({ error: v.error });

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: deps.network,
      asset: deps.usdcAsset,
      payTo: deps.treasury,
      maxAmountRequired: v.amountUsdc,
      resource: "POST /v1/jobs/x402",
    };

    const paymentHeader = req.headers["x-payment"];
    if (typeof paymentHeader !== "string" || paymentHeader.length === 0) {
      return reply.code(402).send({ accepts: [requirements] });
    }

    const result = await deps.verifier.verify(paymentHeader, requirements);
    if (!result.ok) {
      return reply.code(402).send({ error: result.reason ?? "payment failed", accepts: [requirements] });
    }
    if (!result.txRef) {
      return reply.code(402).send({ error: "payment verified without a tx reference", accepts: [requirements] });
    }

    const jobId = computeJobId({
      buyer: v.buyer,
      requirements: v.requirements,
      amountUsdc: v.amountUsdc,
      deadline: v.deadline,
      nonce: body.nonce ?? nonce(),
    });
    try {
      // Consume the payment atomically with the job insert: a tx hash backs exactly
      // one job, so the same payment can't be replayed across jobs.
      const job = await deps.repo.createPaid(
        {
          jobId,
          buyer: v.buyer,
          requirements: v.requirements,
          amountUsdc: v.amountUsdc,
          deadline: v.deadline,
          inputRef: v.inputRef,
        },
        { txHash: result.txRef, amountUsdc: v.amountUsdc },
      );
      return reply.code(201).send({ jobId: job.jobId, status: job.status, payment: { txRef: result.txRef } });
    } catch (err) {
      if (err instanceof DuplicateJobError) return reply.code(409).send({ error: "duplicate job" });
      if (err instanceof PaymentReusedError) return reply.code(409).send({ error: "x402 payment already used" });
      throw err;
    }
  });

  return app;
}

type Validated =
  | { ok: false; error: string }
  | {
      ok: true;
      buyer: Address;
      requirements: JobRequirements;
      amountUsdc: string;
      deadline: number;
      inputRef: string;
    };

function validateSubmit(body: SubmitBody, nowSec: number): Validated {
  if (!isAddress(body.buyer)) return { ok: false, error: "buyer must be a 0x address" };
  if (!body.requirements || !JOB_TYPES.has(String(body.requirements.jobType))) {
    return { ok: false, error: "requirements.jobType is invalid" };
  }
  if (!isUsdcAmount(body.amountUsdc)) return { ok: false, error: "amountUsdc must be a positive integer string" };
  if (typeof body.deadline !== "number" || !Number.isInteger(body.deadline) || body.deadline <= nowSec) {
    return { ok: false, error: "deadline must be a future unix timestamp" };
  }
  if (typeof body.inputRef !== "string" || body.inputRef.length === 0) {
    return { ok: false, error: "inputRef is required" };
  }
  const r = body.requirements;
  for (const k of ["minGpuTier", "minVramGb", "minCpuCores", "minRamGb", "redundancy"] as const) {
    const val = r[k];
    if (val !== undefined && (!Number.isInteger(val) || (val as number) < 0)) {
      return { ok: false, error: `requirements.${k} must be a non-negative integer` };
    }
  }
  if (!Number.isInteger(r.estimatedDurationSec) || (r.estimatedDurationSec as number) <= 0) {
    return { ok: false, error: "requirements.estimatedDurationSec must be a positive integer" };
  }

  return {
    ok: true,
    buyer: body.buyer as Address,
    amountUsdc: body.amountUsdc as string,
    deadline: body.deadline,
    inputRef: body.inputRef,
    requirements: {
      jobType: r.jobType as JobType,
      minGpuTier: r.minGpuTier,
      minVramGb: r.minVramGb,
      minCpuCores: r.minCpuCores,
      minRamGb: r.minRamGb,
      estimatedDurationSec: r.estimatedDurationSec as number,
      redundancy: r.redundancy,
    },
  };
}

function isAddress(v: unknown): v is Address {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isUsdcAmount(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]+$/.test(v) && v !== "0";
}
