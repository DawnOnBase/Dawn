// Jobs repository . The API writes new jobs into the same
// Postgres `jobs` table that the Go job-queue claims from — that shared table is
// the integration seam between the two services. The interface keeps storage
// swappable; the in-memory impl backs tests and local dev.

import type { Address, Hex, Job, JobRequirements, JobStatus } from "@dawn/shared";

export interface NewJob {
  jobId: Hex;
  buyer: Address;
  requirements: JobRequirements;
  amountUsdc: string; // USDC base units (6 dp) as a decimal string
  deadline: number; // unix seconds
  inputRef: string; // off-chain input blob reference
  /**
   * Initial status. Defaults to `submitted`. NOTE: a job becomes `escrowed` ONLY
   * from the indexer's on-chain `JobEscrowed` event — the API never
   * sets `escrowed` itself, so DB `escrowed` always means real on-chain escrow.
   */
  status?: Extract<JobStatus, JobStatus.Submitted>;
}

/** An x402 payment to consume atomically with the job it funds. */
export interface X402Payment {
  txHash: Hex; // the on-chain settlement tx; usable exactly once
  amountUsdc: string; // bound to the job amount
}

export interface JobResult {
  status: JobStatus;
  resultRef?: string; // off-chain output ref, once the node returns it
  outputHash?: Hex; // from the proof bundle (attestation)
}

export interface JobsRepo {
  create(input: NewJob): Promise<Job>;
  /** Create a job and consume its x402 payment in one atomic step. Throws
   *  {@link PaymentReusedError} if the tx was already used. */
  createPaid(input: NewJob, payment: X402Payment): Promise<Job>;
  get(jobId: Hex): Promise<Job | null>;
  result(jobId: Hex): Promise<JobResult | null>;
}

export class DuplicateJobError extends Error {
  constructor(jobId: Hex) {
    super(`job already exists: ${jobId}`);
    this.name = "DuplicateJobError";
  }
}

export class PaymentReusedError extends Error {
  constructor(txHash: Hex) {
    super(`x402 payment already consumed: ${txHash}`);
    this.name = "PaymentReusedError";
  }
}

interface Stored {
  job: Job;
  inputRef: string;
  resultRef?: string;
  outputHash?: Hex;
}

/** In-memory JobsRepo for tests + local dev. */
export class InMemoryJobsRepo implements JobsRepo {
  private readonly rows = new Map<Hex, Stored>();
  private readonly consumedTx = new Set<Hex>();

  async create(input: NewJob): Promise<Job> {
    if (this.rows.has(input.jobId)) throw new DuplicateJobError(input.jobId);
    const job: Job = {
      jobId: input.jobId,
      buyer: input.buyer,
      requirements: input.requirements,
      amountUsdc: input.amountUsdc,
      deadline: input.deadline,
      status: input.status ?? ("submitted" as JobStatus),
    };
    this.rows.set(input.jobId, { job, inputRef: input.inputRef });
    return job;
  }

  async createPaid(input: NewJob, payment: X402Payment): Promise<Job> {
    if (this.consumedTx.has(payment.txHash)) throw new PaymentReusedError(payment.txHash);
    const job = await this.create(input); // throws DuplicateJobError if the job exists
    this.consumedTx.add(payment.txHash);
    return job;
  }

  async get(jobId: Hex): Promise<Job | null> {
    return this.rows.get(jobId)?.job ?? null;
  }

  async result(jobId: Hex): Promise<JobResult | null> {
    const row = this.rows.get(jobId);
    if (!row) return null;
    return { status: row.job.status, resultRef: row.resultRef, outputHash: row.outputHash };
  }

  // Test/dev helper: simulate a node returning a result (normally written by
  // the proof-service once the proof is validated).
  setResult(jobId: Hex, status: JobStatus, resultRef: string, outputHash: Hex): void {
    const row = this.rows.get(jobId);
    if (!row) return;
    row.job.status = status;
    row.resultRef = resultRef;
    row.outputHash = outputHash;
  }
}
