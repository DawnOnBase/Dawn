-- Proof submissions for the proof-service redundancy consensus (architecture ).
-- One row per (job, node): a node's EIP-712-signed proof bundle. The proof-service
-- accumulates these per job and settles once a quorum of outputs agree. Kept in
-- the job-queue migrations because job-queue owns the shared schema.

CREATE TABLE IF NOT EXISTS proof_submissions (
    job_id         TEXT NOT NULL,                 -- == jobs.job_id / Settlement jobId
    node           TEXT NOT NULL,                 -- operator recovered from the signature
    input_hash     TEXT NOT NULL,
    output_hash    TEXT NOT NULL,
    metadata       TEXT NOT NULL,                 -- 0x-hex (raw, hashed into metadataHash)
    node_signature TEXT NOT NULL,                 -- 65-byte EIP-712 (r,s,v)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (job_id, node)                    -- a node submits at most once per job
);

CREATE INDEX IF NOT EXISTS idx_proof_submissions_job ON proof_submissions (job_id);
