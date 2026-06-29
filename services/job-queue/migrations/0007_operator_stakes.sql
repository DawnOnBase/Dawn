-- OperatorStaking reconciliation (M9 capital-isolation vault → matcher StakeOracle feed). The
-- indexer maintains a per-operator free/locked balance from OperatorStaking events; the Go matcher
-- reads free_usdc as a LIVENESS pre-filter (seat only operators that can post the job bond). NUMERIC
-- holds full USDC base-unit precision (no float). Dormant until OperatorStaking is deployed.

CREATE TABLE IF NOT EXISTS operator_stakes (
    operator        TEXT PRIMARY KEY,                 -- node wallet
    free_usdc       NUMERIC NOT NULL DEFAULT 0,       -- lockable / withdrawable-after-unbond stake
    locked_usdc     NUMERIC NOT NULL DEFAULT 0,       -- currently bonded to in-flight jobs
    withdrawable_at BIGINT,                            -- unbond timer (unix s); stake stays slashable until then
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Separate singleton cursor for the stake log scan (distinct contract/block range from the
-- Settlement indexer_cursor, so the two pipelines resume independently).
CREATE TABLE IF NOT EXISTS stake_indexer_cursor (
    id           BOOLEAN PRIMARY KEY DEFAULT TRUE,
    block_number BIGINT NOT NULL,
    log_index    INT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT stake_indexer_cursor_singleton CHECK (id)
);
