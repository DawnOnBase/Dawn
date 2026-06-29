import { afterAll, describe, expect, test } from "bun:test";
import type { Address, Hex } from "@dawn/shared";
import { JobStatus } from "@dawn/shared";
import postgres from "postgres";
import { PostgresIndexerStore } from "../src/pgstate.ts";

const dsn = process.env.DATABASE_URL;
const dbTest = dsn ? test : test.skip;

const JOB = ("0x" + "9".repeat(7) + Date.now().toString(16).padStart(57, "0")) as Hex;
const OPERATOR = "0x2222222222222222222222222222222222222222" as Address;
const TREASURY = "0x3333333333333333333333333333333333333333" as Address;

afterAll(async () => {
  if (!dsn) return;
  const sql = postgres(dsn);
  await sql`DELETE FROM job_settlements WHERE job_id = ${JOB}`;
  await sql`DELETE FROM jobs WHERE job_id = ${JOB}`;
  await sql`DELETE FROM indexer_cursor WHERE id = TRUE`;
  await sql.end();
});

describe("PostgresIndexerStore (integration)", () => {
  dbTest("setStatus reconciles the jobs row", async () => {
    const store = new PostgresIndexerStore(dsn!);
    const sql = postgres(dsn!);
    try {
      await sql`INSERT INTO jobs (job_id, buyer, job_type, amount_usdc, deadline, status)
                VALUES (${JOB}, ${OPERATOR}, 'general_compute', '1000000', 9999999999, 'submitted')`;
      await store.setStatus(JOB, JobStatus.Settled);
      const [row] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE job_id = ${JOB}`;
      expect(row?.status).toBe("settled");
    } finally {
      await store.close();
      await sql.end();
    }
  });

  dbTest("recordSettlement and recordFee upsert job_settlements", async () => {
    const store = new PostgresIndexerStore(dsn!);
    const sql = postgres(dsn!);
    try {
      await store.recordSettlement(JOB, OPERATOR, "995000", "5000");
      await store.recordFee(JOB, TREASURY, "5000");
      const [row] = await sql<
        { operator: string; payout_usdc: string; fee_usdc: string; treasury: string; fee_collected: string }[]
      >`SELECT operator, payout_usdc, fee_usdc, treasury, fee_collected FROM job_settlements WHERE job_id = ${JOB}`;
      expect(row?.operator).toBe(OPERATOR);
      expect(row?.payout_usdc).toBe("995000");
      expect(row?.fee_usdc).toBe("5000");
      expect(row?.treasury).toBe(TREASURY);
      expect(row?.fee_collected).toBe("5000");
    } finally {
      await store.close();
      await sql.end();
    }
  });

  dbTest("cursor save/load round-trips", async () => {
    const store = new PostgresIndexerStore(dsn!);
    try {
      expect(await store.load()).toBeNull(); // cleaned state
      await store.save({ blockNumber: 43467497, logIndex: 2 });
      expect(await store.load()).toEqual({ blockNumber: 43467497, logIndex: 2 });
      // Upsert advances the singleton row in place.
      await store.save({ blockNumber: 43467600, logIndex: 0 });
      expect(await store.load()).toEqual({ blockNumber: 43467600, logIndex: 0 });
    } finally {
      await store.close();
    }
  });

  dbTest("pendingConsensusJobs returns only redundant 'proven' jobs with package pointers", async () => {
    const store = new PostgresIndexerStore(dsn!);
    const sql = postgres(dsn!);
    const suffix = Date.now().toString(16).padStart(56, "0");
    const redundant = ("0x" + "a".repeat(8) + suffix) as Hex; // redundant + proven → included
    const single = ("0x" + "b".repeat(8) + suffix) as Hex; // single-node proven → excluded
    const challenged = ("0x" + "c".repeat(8) + suffix) as Hex; // redundant but failed → excluded
    const BUYER = "0x4444444444444444444444444444444444444444" as Address;
    const ROOT = ("0x" + "ee".repeat(32)) as Hex;
    const IN_HASH = ("0x" + "dd".repeat(32)) as Hex;
    try {
      await sql`INSERT INTO jobs (job_id, buyer, job_type, amount_usdc, deadline, status, input_ref, input_hash, operator_set_root)
                VALUES (${redundant}, ${BUYER}, 'general_compute', '100000000', 9999999999, 'proven', 'ipfs://pkg', ${IN_HASH}, ${ROOT})`;
      await sql`INSERT INTO jobs (job_id, buyer, job_type, amount_usdc, deadline, status, input_ref, input_hash)
                VALUES (${single}, ${BUYER}, 'general_compute', '100000000', 9999999999, 'proven', 'ipfs://s', ${IN_HASH})`;
      await sql`INSERT INTO jobs (job_id, buyer, job_type, amount_usdc, deadline, status, input_ref, input_hash, operator_set_root)
                VALUES (${challenged}, ${BUYER}, 'general_compute', '100000000', 9999999999, 'failed', 'ipfs://c', ${IN_HASH}, ${ROOT})`;

      const all = await store.pendingConsensusJobs();
      const ids = all.map((j) => j.jobId);
      expect(ids).toContain(redundant);
      expect(ids).not.toContain(single); // not redundant (no operatorSetRoot)
      expect(ids).not.toContain(challenged); // challenged → 'failed'

      const mine = all.find((j) => j.jobId === redundant)!;
      expect(mine.inputRef).toBe("ipfs://pkg");
      expect(mine.inputHash).toBe(IN_HASH);
      expect(mine.buyer.toLowerCase()).toBe(BUYER.toLowerCase());

      // Buyer filter still includes ours; a different buyer excludes it.
      expect((await store.pendingConsensusJobs(BUYER)).map((j) => j.jobId)).toContain(redundant);
      expect(
        (await store.pendingConsensusJobs("0x5555555555555555555555555555555555555555" as Address)).map((j) => j.jobId),
      ).not.toContain(redundant);
    } finally {
      await sql`DELETE FROM jobs WHERE job_id IN (${redundant}, ${single}, ${challenged})`;
      await store.close();
      await sql.end();
    }
  });
});
