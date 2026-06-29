-- x402 consumed-payment ledger (architecture ; a design decision / M3).
--
-- Each settlement tx hash may back exactly ONE job. PK(tx_hash) turns a replayed
-- payment into a unique-violation, and the row is inserted in the SAME transaction
-- as the job, so one payment can never fund two jobs (the double-spend hole).
CREATE TABLE IF NOT EXISTS x402_payments (
    tx_hash     TEXT PRIMARY KEY,          -- the on-chain settlement tx; one payment, one use
    job_id      TEXT NOT NULL,             -- the job this payment funded
    amount_usdc TEXT NOT NULL,             -- USDC base units (6 dp); bound to the job amount
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_x402_payments_job ON x402_payments (job_id);
