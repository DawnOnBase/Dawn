-- M9 redundant-execution committee assignment (the redundant-execution design ).
-- All columns are additive + nullable so the single-node rows are unaffected. A redundant job
-- carries the orchestrator-signed Assignment (committee, Merkle root, signature, nonce, bond) and
-- the orchestrator-pinned inputHash the contract verifies at escrowRedundant.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_hash        TEXT;   -- keccak256(canonical Job Package), pinned
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS operators         TEXT[]; -- M authorized operators, assignment (Merkle) order
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS operator_set_root TEXT;   -- sorted-pair Merkle root over operators
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assignment_sig    TEXT;   -- orchestrator EIP-712 signature
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS nonce             BIGINT; -- monotonic per job_id (replay-safe)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bond              TEXT;   -- per-job operator bond, USDC base units (string)

-- One row per (job, operator) submission: the durable "one slot per operator" ledger powering
-- quorum counting and the FindCommitteeJob skip of already-submitted members. PK makes a replayed
-- submission a unique-violation (the contract's submissions[jobId][operator].submitted, off-chain).
CREATE TABLE IF NOT EXISTS committee_submissions (
    job_id       TEXT NOT NULL,
    operator     TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, operator)
);

CREATE INDEX IF NOT EXISTS idx_committee_subs_job ON committee_submissions (job_id);
