-- Result + attestation columns on the shared jobs table (architecture , ).
-- Written by the proof-service once a node's output is returned and validated;
-- read by the API's GET /v1/jobs/:id/result. Kept here because job-queue owns
-- the jobs-table schema (single source of truth for both services).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_ref  TEXT;  -- off-chain output blob ref
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS output_hash TEXT;  -- proof bundle outputHash (attestation)
