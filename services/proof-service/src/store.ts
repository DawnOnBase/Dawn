// Postgres-backed ProofStore . Persists proof submissions
// so redundancy accumulation survives restarts; replaces InMemoryProofStore in
// production. One row per (job, node) — a node submits at most once per job.

import type { Hex } from "@dawn/shared";
import postgres from "postgres";
import type { ProofSubmission } from "./consensus.ts";
import type { ProofStore } from "./service.ts";

export class PostgresProofStore implements ProofStore {
  private readonly sql: postgres.Sql;

  constructor(dsn: string) {
    this.sql = postgres(dsn);
  }

  async add(jobId: Hex, sub: ProofSubmission): Promise<number> {
    const p = sub.proof;
    // Idempotent: a resubmission by the same node for the same job is ignored,
    // so retried deliveries don't inflate the quorum count.
    await this.sql`
      INSERT INTO proof_submissions (job_id, node, input_hash, output_hash, metadata, node_signature)
      VALUES (${jobId}, ${sub.node}, ${p.inputHash}, ${p.outputHash}, ${p.metadata}, ${p.nodeSignature})
      ON CONFLICT (job_id, node) DO NOTHING`;
    const [row] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM proof_submissions WHERE job_id = ${jobId}`;
    return row?.n ?? 0;
  }

  async list(jobId: Hex): Promise<ProofSubmission[]> {
    const rows = await this.sql<
      { node: string; input_hash: string; output_hash: string; metadata: string; node_signature: string }[]
    >`SELECT node, input_hash, output_hash, metadata, node_signature
        FROM proof_submissions WHERE job_id = ${jobId} ORDER BY created_at`;
    return rows.map((r) => ({
      node: r.node as Hex,
      proof: {
        jobId,
        inputHash: r.input_hash as Hex,
        outputHash: r.output_hash as Hex,
        metadata: r.metadata as Hex,
        nodeSignature: r.node_signature as Hex,
      },
    }));
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
