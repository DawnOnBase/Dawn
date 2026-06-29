// Postgres JobsRepo . Writes to the same `jobs` table the
// Go job-queue claims from (schema in services/job-queue/migrations). Compiles
// here; live-DB integration tests run in CI (DATABASE_URL).

import postgres from "postgres";
import type { Address, Hex, Job, JobStatus, JobType } from "@dawn/shared";
import {
  DuplicateJobError,
  PaymentReusedError,
  type JobResult,
  type JobsRepo,
  type NewJob,
  type X402Payment,
} from "./jobs.ts";

interface JobRow {
  job_id: string;
  buyer: string;
  job_type: string;
  amount_usdc: string;
  deadline: string | number;
  status: string;
  operator: string | null;
  min_gpu_tier: number | null;
  min_vram_gb: number | null;
  min_cpu_cores: number | null;
  min_ram_gb: number | null;
  estimated_duration_sec: number;
  redundancy: number | null;
  result_ref?: string | null;
  output_hash?: string | null;
}

function toJob(r: JobRow): Job {
  return {
    jobId: r.job_id as Hex,
    buyer: r.buyer as Address,
    amountUsdc: r.amount_usdc,
    deadline: Number(r.deadline),
    status: r.status as JobStatus,
    operator: (r.operator as Address | null) ?? undefined,
    requirements: {
      jobType: r.job_type as JobType,
      minGpuTier: r.min_gpu_tier ?? undefined,
      minVramGb: r.min_vram_gb ?? undefined,
      minCpuCores: r.min_cpu_cores ?? undefined,
      minRamGb: r.min_ram_gb ?? undefined,
      estimatedDurationSec: r.estimated_duration_sec,
      redundancy: r.redundancy ?? undefined,
    },
  };
}

export class PostgresJobsRepo implements JobsRepo {
  private readonly sql: postgres.Sql;

  constructor(dsn: string) {
    this.sql = postgres(dsn);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async create(input: NewJob): Promise<Job> {
    const r = input.requirements;
    const status = input.status ?? ("submitted" as JobStatus);
    try {
      await this.sql`
        INSERT INTO jobs (job_id, buyer, job_type, amount_usdc, deadline, status, input_ref,
          min_gpu_tier, min_vram_gb, min_cpu_cores, min_ram_gb, estimated_duration_sec, redundancy)
        VALUES (${input.jobId}, ${input.buyer}, ${r.jobType}, ${input.amountUsdc}, ${input.deadline},
          ${status}, ${input.inputRef}, ${r.minGpuTier ?? null}, ${r.minVramGb ?? null},
          ${r.minCpuCores ?? null}, ${r.minRamGb ?? null}, ${r.estimatedDurationSec}, ${r.redundancy ?? null})
      `;
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === "23505") {
        throw new DuplicateJobError(input.jobId);
      }
      throw err;
    }
    return {
      jobId: input.jobId,
      buyer: input.buyer,
      requirements: input.requirements,
      amountUsdc: input.amountUsdc,
      deadline: input.deadline,
      status,
    };
  }

  async createPaid(input: NewJob, payment: X402Payment): Promise<Job> {
    const r = input.requirements;
    const status = input.status ?? ("submitted" as JobStatus);
    try {
      await this.sql.begin(async (sql) => {
        // Consume the payment first: PK(tx_hash) makes a replay fail fast, and being
        // in the same transaction as the job insert means one tx can't fund two jobs.
        await sql`INSERT INTO x402_payments (tx_hash, job_id, amount_usdc)
          VALUES (${payment.txHash}, ${input.jobId}, ${payment.amountUsdc})`;
        await sql`
          INSERT INTO jobs (job_id, buyer, job_type, amount_usdc, deadline, status, input_ref,
            min_gpu_tier, min_vram_gb, min_cpu_cores, min_ram_gb, estimated_duration_sec, redundancy)
          VALUES (${input.jobId}, ${input.buyer}, ${r.jobType}, ${input.amountUsdc}, ${input.deadline},
            ${status}, ${input.inputRef}, ${r.minGpuTier ?? null}, ${r.minVramGb ?? null},
            ${r.minCpuCores ?? null}, ${r.minRamGb ?? null}, ${r.estimatedDurationSec}, ${r.redundancy ?? null})
        `;
      });
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === "23505") {
        // Distinguish the replayed-payment PK from the duplicate-job PK.
        const constraint = (err as { constraint_name?: string }).constraint_name ?? "";
        if (constraint.includes("x402")) throw new PaymentReusedError(payment.txHash);
        throw new DuplicateJobError(input.jobId);
      }
      throw err;
    }
    return {
      jobId: input.jobId,
      buyer: input.buyer,
      requirements: input.requirements,
      amountUsdc: input.amountUsdc,
      deadline: input.deadline,
      status,
    };
  }

  async get(jobId: Hex): Promise<Job | null> {
    const rows = await this.sql<JobRow[]>`
      SELECT job_id, buyer, job_type, amount_usdc, deadline, status, operator,
        min_gpu_tier, min_vram_gb, min_cpu_cores, min_ram_gb, estimated_duration_sec, redundancy
      FROM jobs WHERE job_id = ${jobId}`;
    const row = rows[0];
    return row ? toJob(row) : null;
  }

  async result(jobId: Hex): Promise<JobResult | null> {
    const rows = await this.sql<JobRow[]>`
      SELECT status, result_ref, output_hash FROM jobs WHERE job_id = ${jobId}`;
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status as JobStatus,
      resultRef: row.result_ref ?? undefined,
      outputHash: (row.output_hash as Hex | null) ?? undefined,
    };
  }
}
