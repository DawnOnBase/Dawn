-- Indexer reconciliation state (architecture ). The indexer updates jobs.status
-- from on-chain truth and records settlement/fee detail for accounting, plus a
-- single-row resumable cursor so restarts don't re-scan from the deploy block.

-- Settlement + fee detail, keyed by job. Filled from JobSettled / FeeCollected.
CREATE TABLE IF NOT EXISTS job_settlements (
    job_id        TEXT PRIMARY KEY,              -- == jobs.job_id
    operator      TEXT,                          -- paid node (JobSettled)
    payout_usdc   TEXT,                          -- USDC base units (6 dp)
    fee_usdc      TEXT,                          -- fee component of JobSettled
    treasury      TEXT,                          -- fee sink (FeeCollected)
    fee_collected TEXT,                          -- fee amount (FeeCollected)
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Singleton cursor row (id is always TRUE), the indexer's resume point.
CREATE TABLE IF NOT EXISTS indexer_cursor (
    id           BOOLEAN PRIMARY KEY DEFAULT TRUE,
    block_number BIGINT NOT NULL,
    log_index    INT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT indexer_cursor_singleton CHECK (id)
);
