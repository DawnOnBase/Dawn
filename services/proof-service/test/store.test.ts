import { afterAll, describe, expect, test } from "bun:test";
import type { Hex } from "@dawn/shared";
import postgres from "postgres";
import { PostgresProofStore } from "../src/store.ts";

const dsn = process.env.DATABASE_URL;
const dbTest = dsn ? test : test.skip;

// Unique job id per run so the test is isolated and self-cleaning on the shared DB.
const JOB = ("0x" + "7".repeat(7) + Date.now().toString(16).padStart(57, "0")) as Hex;
const NODE_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const NODE_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

function sub(node: Hex, outputHash: Hex) {
  return {
    node,
    proof: { jobId: JOB, inputHash: ("0x" + "11".repeat(32)) as Hex, outputHash, metadata: "0x" as Hex, nodeSignature: ("0x" + "22".repeat(65)) as Hex },
  };
}

afterAll(async () => {
  if (!dsn) return;
  const sql = postgres(dsn);
  await sql`DELETE FROM proof_submissions WHERE job_id = ${JOB}`;
  await sql.end();
});

describe("PostgresProofStore (integration)", () => {
  dbTest("persists submissions, counts them, and is idempotent per node", async () => {
    const store = new PostgresProofStore(dsn!);
    try {
      expect(await store.add(JOB, sub(NODE_A, ("0x" + "cc".repeat(32)) as Hex))).toBe(1);
      expect(await store.add(JOB, sub(NODE_B, ("0x" + "cc".repeat(32)) as Hex))).toBe(2);
      // Same node resubmits -> no double count.
      expect(await store.add(JOB, sub(NODE_A, ("0x" + "cc".repeat(32)) as Hex))).toBe(2);

      const listed = await store.list(JOB);
      expect(listed.length).toBe(2);
      expect(listed.map((s) => s.node).sort()).toEqual([NODE_A, NODE_B].sort());
      expect(listed[0]!.proof.jobId).toBe(JOB);
    } finally {
      await store.close();
    }
  });
});
