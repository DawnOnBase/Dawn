// Postgres-backed indexer persistence . Reconciles
// on-chain truth into the shared jobs table and records settlement/fee detail,
// plus a durable single-row cursor. One class implements both the JobStateWriter
// and CursorStore interfaces so they share a single connection.

import type { Address, Hex, JobStatus } from "@dawn/shared";
import postgres from "postgres";
import type { Cursor } from "./events.ts";
import type { CursorStore } from "./indexer.ts";
import type { StakeCursorStore, StakeStateWriter } from "./stake.ts";
import type { JobStateWriter } from "./state.ts";

/** A redundant job awaiting watchtower verification — the off-chain package pointers it needs to
 *  re-execute. The authoritative consensus window + winningHash are read from chain by the
 *  watchtower (this is only the candidate list, not a payout authority). */
export interface PendingConsensusJob {
  jobId: Hex;
  buyer: Address;
  inputRef: string;
  inputHash: Hex;
}

interface PendingConsensusRow {
  job_id: Hex;
  buyer: Address;
  input_ref: string;
  input_hash: Hex;
}

export class PostgresIndexerStore implements JobStateWriter, StakeStateWriter, CursorStore, StakeCursorStore {
  private readonly sql: postgres.Sql;

  constructor(dsn: string) {
    this.sql = postgres(dsn);
  }

  // --- read: watchtower candidate set (M9 S2) ---

  /** Redundant jobs that reached on-chain consensus (status 'proven' set by JobConsensus) and are
   *  not yet challenged ('failed') or settled — the candidates the watchtower re-executes. We surface
   *  only the package pointers (inputRef + inputHash); the watchtower reads the authoritative
   *  consensusAt/winningHash/status from chain before acting (fail-safe — never challenge on stale
   *  off-chain data). Optionally scoped to one buyer (the buyer's-keeper watchtower). */
  async pendingConsensusJobs(buyer?: Address): Promise<PendingConsensusJob[]> {
    const rows = buyer
      ? await this.sql<PendingConsensusRow[]>`
          SELECT job_id, buyer, input_ref, input_hash FROM jobs
          WHERE status = 'proven' AND operator_set_root IS NOT NULL
            AND input_ref IS NOT NULL AND input_hash IS NOT NULL AND buyer = ${buyer}`
      : await this.sql<PendingConsensusRow[]>`
          SELECT job_id, buyer, input_ref, input_hash FROM jobs
          WHERE status = 'proven' AND operator_set_root IS NOT NULL
            AND input_ref IS NOT NULL AND input_hash IS NOT NULL`;
    return rows.map((r) => ({ jobId: r.job_id, buyer: r.buyer, inputRef: r.input_ref, inputHash: r.input_hash }));
  }

  // --- JobStateWriter (chain is authoritative for escrow/settle/refund) ---

  async setStatus(jobId: Hex, status: JobStatus): Promise<void> {
    // Update only — a job we never originated still has its on-chain status
    // tracked via job_settlements; the jobs row stays the API's source of truth.
    await this.sql`UPDATE jobs SET status = ${status}, updated_at = now() WHERE job_id = ${jobId}`;
  }

  async recordSettlement(jobId: Hex, operator: Address, amountUsdc: string, feeUsdc: string): Promise<void> {
    await this.sql`
      INSERT INTO job_settlements (job_id, operator, payout_usdc, fee_usdc, updated_at)
      VALUES (${jobId}, ${operator}, ${amountUsdc}, ${feeUsdc}, now())
      ON CONFLICT (job_id) DO UPDATE
        SET operator = EXCLUDED.operator, payout_usdc = EXCLUDED.payout_usdc,
            fee_usdc = EXCLUDED.fee_usdc, updated_at = now()`;
    await this.sql`UPDATE jobs SET operator = ${operator}, updated_at = now() WHERE job_id = ${jobId}`;
  }

  async recordFee(jobId: Hex, treasury: Address, amountUsdc: string): Promise<void> {
    await this.sql`
      INSERT INTO job_settlements (job_id, treasury, fee_collected, updated_at)
      VALUES (${jobId}, ${treasury}, ${amountUsdc}, now())
      ON CONFLICT (job_id) DO UPDATE
        SET treasury = EXCLUDED.treasury, fee_collected = EXCLUDED.fee_collected, updated_at = now()`;
  }

  async recordRedundantAuthorization(
    jobId: Hex,
    operatorSetRoot: Hex,
    redundancy: number,
    bond: string,
    nonce: number,
  ): Promise<void> {
    // Persist the on-chain committee facts onto the shared jobs row (columns from job-queue
    // migration 0006). Update-only: the row originates from job submission / JobEscrowed.
    await this.sql`
      UPDATE jobs
      SET operator_set_root = ${operatorSetRoot}, redundancy = ${redundancy},
          bond = ${bond}, nonce = ${nonce}, updated_at = now()
      WHERE job_id = ${jobId}`;
  }

  // --- StakeStateWriter (operator_stakes feeds the matcher's StakeOracle) ---

  async setFree(operator: Address, free: string): Promise<void> {
    await this.sql`
      INSERT INTO operator_stakes (operator, free_usdc, locked_usdc, updated_at)
      VALUES (${operator}, ${free}, 0, now())
      ON CONFLICT (operator) DO UPDATE SET free_usdc = ${free}, updated_at = now()`;
  }

  async adjust(operator: Address, freeDelta: string, lockedDelta: string): Promise<void> {
    // GREATEST(0, …) floors balances so a cold-start mid-history can't go negative.
    await this.sql`
      INSERT INTO operator_stakes (operator, free_usdc, locked_usdc, updated_at)
      VALUES (${operator}, GREATEST(0, ${freeDelta}::numeric), GREATEST(0, ${lockedDelta}::numeric), now())
      ON CONFLICT (operator) DO UPDATE
        SET free_usdc   = GREATEST(0, operator_stakes.free_usdc::numeric   + ${freeDelta}::numeric),
            locked_usdc = GREATEST(0, operator_stakes.locked_usdc::numeric + ${lockedDelta}::numeric),
            updated_at  = now()`;
  }

  async setWithdrawableAt(operator: Address, withdrawableAt: number): Promise<void> {
    await this.sql`
      INSERT INTO operator_stakes (operator, free_usdc, locked_usdc, withdrawable_at, updated_at)
      VALUES (${operator}, 0, 0, ${withdrawableAt}, now())
      ON CONFLICT (operator) DO UPDATE SET withdrawable_at = ${withdrawableAt}, updated_at = now()`;
  }

  // --- CursorStore (singleton row id = TRUE) ---

  async load(): Promise<Cursor | null> {
    const [row] = await this.sql<{ block_number: string; log_index: number }[]>`
      SELECT block_number, log_index FROM indexer_cursor WHERE id = TRUE`;
    return row ? { blockNumber: Number(row.block_number), logIndex: row.log_index } : null;
  }

  async save(cursor: Cursor): Promise<void> {
    await this.sql`
      INSERT INTO indexer_cursor (id, block_number, log_index, updated_at)
      VALUES (TRUE, ${cursor.blockNumber}, ${cursor.logIndex}, now())
      ON CONFLICT (id) DO UPDATE
        SET block_number = EXCLUDED.block_number, log_index = EXCLUDED.log_index, updated_at = now()`;
  }

  // --- StakeCursorStore (separate singleton row) ---

  async loadStake(): Promise<Cursor | null> {
    const [row] = await this.sql<{ block_number: string; log_index: number }[]>`
      SELECT block_number, log_index FROM stake_indexer_cursor WHERE id = TRUE`;
    return row ? { blockNumber: Number(row.block_number), logIndex: row.log_index } : null;
  }

  async saveStake(cursor: Cursor): Promise<void> {
    await this.sql`
      INSERT INTO stake_indexer_cursor (id, block_number, log_index, updated_at)
      VALUES (TRUE, ${cursor.blockNumber}, ${cursor.logIndex}, now())
      ON CONFLICT (id) DO UPDATE
        SET block_number = EXCLUDED.block_number, log_index = EXCLUDED.log_index, updated_at = now()`;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
