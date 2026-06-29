-- job-queue schema (architecture , ).
-- The jobs table is the durable queue + state store. The JOINT domain.Job wire
-- type is a subset of these columns; input_ref/created_at/etc. are
-- backend-internal and never leave the backend.

CREATE TABLE IF NOT EXISTS jobs (
    job_id                 TEXT PRIMARY KEY,           -- keccak256, == Settlement contract jobId
    buyer                  TEXT NOT NULL,
    job_type               TEXT NOT NULL,
    amount_usdc            TEXT NOT NULL,              -- USDC base units (6 dp) as a decimal string
    deadline               BIGINT NOT NULL,           -- unix seconds
    status                 TEXT NOT NULL,             -- JobStatus enum (packages/shared)
    operator               TEXT,                      -- assigned node wallet, once matched
    input_ref              TEXT,                      -- off-chain input blob ref (backend-internal)
    min_gpu_tier           INT,
    min_vram_gb            INT,
    min_cpu_cores          INT,
    min_ram_gb             INT,
    estimated_duration_sec INT  NOT NULL DEFAULT 0,
    redundancy             INT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT jobs_status_chk CHECK (status IN
        ('submitted','escrowed','matched','running','proven','settled','failed','timed_out'))
);

-- Partial index powering the claim hot path: only escrowed rows are claimable,
-- ordered work-stealing via FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS idx_jobs_claimable
    ON jobs (deadline)
    WHERE status = 'escrowed';

CREATE INDEX IF NOT EXISTS idx_jobs_operator ON jobs (operator);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs (status);
