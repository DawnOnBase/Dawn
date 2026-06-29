package postgres

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
)

// StakeOracle is the indexer-fed matching.StakeOracle (M9 doc #1). It serves the committee
// matcher's bond pre-filter from an in-memory snapshot of operator_stakes (which the indexer keeps
// reconciled from OperatorStaking events), refreshed on a ticker — so EffectiveStake is a lock-read
// map lookup and the matching hot path never touches the DB. It is a LIVENESS hint, not consensus
// state, so a slightly stale snapshot is fine.
type StakeOracle struct {
	pool *pgxpool.Pool
	mu   sync.RWMutex
	snap matching.MapStakeOracle
}

// NewStakeOracle builds an oracle over the same pool the queue uses. Call Refresh (or Run) before
// relying on it; until the first refresh it reports 0 for every operator (filter excludes all).
func NewStakeOracle(pool *pgxpool.Pool) *StakeOracle {
	return &StakeOracle{pool: pool, snap: matching.MapStakeOracle{}}
}

// StakeOracle returns an oracle bound to this Store's pool.
func (s *Store) StakeOracle() *StakeOracle { return NewStakeOracle(s.pool) }

// EffectiveStake returns the operator's free stake (USDC base units) from the current snapshot.
func (o *StakeOracle) EffectiveStake(operator domain.Address) uint64 {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.snap.EffectiveStake(operator)
}

// Refresh reloads the whole free-stake snapshot in one query and swaps it in atomically. free_usdc
// is an integer-valued NUMERIC (USDC base units), cast to bigint for a clean scan; non-positive
// balances are dropped (they fail any bond filter anyway).
func (o *StakeOracle) Refresh(ctx context.Context) error {
	rows, err := o.pool.Query(ctx, `SELECT operator, free_usdc::bigint FROM operator_stakes WHERE free_usdc > 0`)
	if err != nil {
		return err
	}
	defer rows.Close()

	next := make(matching.MapStakeOracle)
	for rows.Next() {
		var op string
		var free int64
		if err := rows.Scan(&op, &free); err != nil {
			return err
		}
		if free > 0 {
			next[domain.Address(op)] = uint64(free)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	o.mu.Lock()
	o.snap = next
	o.mu.Unlock()
	return nil
}

// Run refreshes the snapshot every `interval` until ctx is cancelled (best-effort; a failed refresh
// keeps the last good snapshot). It does an immediate first refresh so the oracle is warm.
func (o *StakeOracle) Run(ctx context.Context, interval time.Duration, onErr func(error)) {
	report := func(err error) {
		if err != nil && onErr != nil {
			onErr(err)
		}
	}
	report(o.Refresh(ctx))
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			report(o.Refresh(ctx))
		}
	}
}

// compile-time assertion that StakeOracle satisfies the matcher seam.
var _ matching.StakeOracle = (*StakeOracle)(nil)
