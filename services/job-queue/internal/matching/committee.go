package matching

import (
	"sort"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// StakeOracle reports an operator's effective (free, slashable) stake in USDC base units, as
// reconciled from OperatorStaking on-chain events by the indexer. It backs a LIVENESS pre-filter
// for the committee matcher — seat only operators that can post the job bond so the contract's
// submitProof rarely reverts BOND_TOO_LOW. It is NOT the Sybil gate (that is committee distinctness
// + orchestrator authorization, M9 doc). Implementations must be safe for concurrent use.
type StakeOracle interface {
	// EffectiveStake returns the operator's free stake in USDC base units; an unknown operator is 0.
	EffectiveStake(operator domain.Address) uint64
}

// MapStakeOracle is an in-memory StakeOracle (tests + the shape the indexer-fed oracle implements).
type MapStakeOracle map[domain.Address]uint64

func (m MapStakeOracle) EffectiveStake(op domain.Address) uint64 { return m[op] }

type committeeConfig struct {
	stake   StakeOracle
	minBond uint64
}

// CommitteeOption tunes AssignCommittee. Without options the stake pre-filter is OFF (every eligible
// node is seatable) — the behavior before the StakeOracle / OperatorStaking indexer source lands.
type CommitteeOption func(*committeeConfig)

// WithStakeFilter seats only operators whose effective stake covers minBond (per-job bond, USDC base
// units). A nil oracle is a no-op so callers can pass an unconfigured oracle safely.
func WithStakeFilter(oracle StakeOracle, minBond uint64) CommitteeOption {
	return func(c *committeeConfig) { c.stake = oracle; c.minBond = minBond }
}

// AssignCommittee selects exactly `m` DISTINCT eligible operators for a redundant job. This
// distinctness is the actual Sybil cut (M9 doc): the orchestrator then signs an Assignment
// over these operators, and the contract lets each submit at most once — so one real actor can
// occupy at most one seat ONLY IF the matcher never seats the same NodeID twice. An honest matcher
// also prefers reputable, geographically-spread nodes.
//
// Ranking: reliability desc, then NodeID (deterministic), with a soft spread across distinct
// regions when m >= 3. Returns nil if fewer than `m` distinct eligible nodes exist — the job cannot
// be safely seated and must wait or fall back to single-node.
//
// The returned slice order is canonical: the caller builds the Merkle root + per-node proofs over
// it (orchestrator.MerkleRoot / MerkleProof), so the order must be preserved through assignment.
func AssignCommittee(
	nodes []domain.NodeProfile, req domain.JobRequirements, m int, now int64, w Weights, opts ...CommitteeOption,
) []domain.NodeProfile {
	if m < 2 {
		return nil
	}
	w = w.withDefaults()
	var cfg committeeConfig
	for _, o := range opts {
		o(&cfg)
	}

	// Eligible + (optional) stake pre-filter + dedupe by NodeID (first occurrence wins).
	seen := make(map[domain.Address]bool, len(nodes))
	pool := make([]domain.NodeProfile, 0, len(nodes))
	for _, n := range nodes {
		if n.NodeID == "" || seen[n.NodeID] {
			continue
		}
		if !Eligible(n, req) {
			continue
		}
		if cfg.stake != nil && cfg.stake.EffectiveStake(n.NodeID) < cfg.minBond {
			continue // can't post the bond → seating it would just revert on-chain (liveness filter)
		}
		seen[n.NodeID] = true
		pool = append(pool, n)
	}
	if len(pool) < m {
		return nil
	}

	// Rank by reliability (desc), tie-break by NodeID for determinism.
	sort.SliceStable(pool, func(a, b int) bool {
		if pool[a].ReliabilityScore != pool[b].ReliabilityScore {
			return pool[a].ReliabilityScore > pool[b].ReliabilityScore
		}
		return pool[a].NodeID < pool[b].NodeID
	})

	if m >= 3 {
		return spreadSelect(pool, m)
	}
	return append([]domain.NodeProfile(nil), pool[:m]...)
}

// spreadSelect picks the highest-ranked node from each distinct region first (soft anti-correlation
// of failures / collusion), then fills remaining slots from the leftover ranked pool.
func spreadSelect(pool []domain.NodeProfile, m int) []domain.NodeProfile {
	selected := make([]domain.NodeProfile, 0, m)
	usedRegion := make(map[string]bool)
	usedIdx := make(map[int]bool)

	for i, n := range pool {
		if len(selected) == m {
			break
		}
		if !usedRegion[n.Region] {
			usedRegion[n.Region] = true
			usedIdx[i] = true
			selected = append(selected, n)
		}
	}
	for i, n := range pool {
		if len(selected) == m {
			break
		}
		if !usedIdx[i] {
			selected = append(selected, n)
		}
	}
	return selected
}

// CommitteeAddresses extracts the operator addresses (NodeIDs) in assignment order — the exact
// input order for orchestrator.MerkleRoot / MerkleProof.
func CommitteeAddresses(committee []domain.NodeProfile) []domain.Address {
	out := make([]domain.Address, len(committee))
	for i, n := range committee {
		out[i] = n.NodeID
	}
	return out
}
