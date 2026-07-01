// Package dispatch is the committee authority's runtime (M9 doc): it turns a redundant job into
// an orchestrator-signed committee chosen from the currently-connected operators, and activates that
// committee once the job is escrowed on-chain so its members can pull.
//
// Flow (backend-orchestrated, M0 D4 preserving — see the decision notes in the runbook):
//  1. PrepareAndSign: pick M distinct connected operators (reliability-ranked, region-spread,
//     stake-gated), EIP-712-sign the Assignment, stash it, and return it for the escrowRedundant
//     caller (the buyer or a relayer — that on-chain write is the settlement seam).
//  2. On JobEscrowed (observed via the indexer), Activate records the stashed committee on the job
//     (Escrowed → Matched) so coordinator.FindCommitteeJob hands it to its members.
//
// The orchestrator signature is the one root of trust for the redundant flow; the signing key
// is held by orchestrator.Signer (a multisig/threshold key in production).
package dispatch

import (
	"context"
	"fmt"
	"math/big"
	"sync"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/orchestrator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/presence"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
)

// Service builds + activates committees. Safe for concurrent use.
type Service struct {
	q        queue.Queue
	signer   *orchestrator.Signer
	registry *presence.Registry
	stake    matching.StakeOracle // optional bond pre-filter
	weights  matching.Weights
	now      queue.Clock

	mu      sync.Mutex
	pending map[domain.Hex]queue.CommitteeAssignment // jobID → signed committee awaiting escrow
	nonces  map[domain.Hex]uint64                    // jobID → last issued nonce
}

// New builds a dispatch Service. `stake` may be nil to skip the bond pre-filter.
func New(q queue.Queue, signer *orchestrator.Signer, registry *presence.Registry, stake matching.StakeOracle, w matching.Weights, now queue.Clock) *Service {
	if now == nil {
		now = func() int64 { return 0 }
	}
	return &Service{
		q: q, signer: signer, registry: registry, stake: stake, weights: w, now: now,
		pending: make(map[domain.Hex]queue.CommitteeAssignment),
		nonces:  make(map[domain.Hex]uint64),
	}
}

// Result is the signed authorization the escrowRedundant caller needs.
type Result struct {
	Operators       []domain.Address
	OperatorSetRoot domain.Hex
	AssignmentSig   domain.Hex
	InputHash       domain.Hex
	Nonce           uint64
	Bond            string
	Amount          string
	Deadline        int64
	Redundancy      int
}

// ErrInsufficientNodes is returned when fewer than M eligible, distinct, sufficiently-staked nodes
// are connected to seat a committee — the job must wait (or fall back to single-node).
var ErrInsufficientNodes = fmt.Errorf("dispatch: not enough eligible connected nodes for a committee")

// PrepareAndSign selects a committee for a redundant job and signs its Assignment. `inputHash` is the
// orchestrator-pinned keccak256(canonical Job Package); `bond` is the per-job operator bond (USDC
// base units). It does NOT touch the job's status — activation happens after escrow.
func (s *Service) PrepareAndSign(ctx context.Context, jobID domain.Hex, inputHash domain.Hex, bond string) (*Result, error) {
	job, err := s.q.Get(ctx, jobID)
	if err != nil {
		return nil, err
	}
	if !job.IsRedundant() {
		return nil, fmt.Errorf("dispatch: job %s is not redundant", jobID)
	}
	m := *job.Requirements.Redundancy

	amount, ok := new(big.Int).SetString(job.AmountUsdc, 10)
	if !ok {
		return nil, fmt.Errorf("dispatch: bad job amount %q", job.AmountUsdc)
	}
	bondBig, ok := new(big.Int).SetString(bond, 10)
	if !ok {
		return nil, fmt.Errorf("dispatch: bad bond %q", bond)
	}

	var opts []matching.CommitteeOption
	if s.stake != nil {
		opts = append(opts, matching.WithStakeFilter(s.stake, bondBig.Uint64()))
	}
	committee := matching.AssignCommittee(s.registry.Snapshot(), job.Requirements, m, s.now(), s.weights, opts...)
	if committee == nil {
		return nil, ErrInsufficientNodes
	}
	operators := matching.CommitteeAddresses(committee)

	s.mu.Lock()
	nonce := s.nonces[jobID] + 1
	s.nonces[jobID] = nonce
	s.mu.Unlock()

	signed, err := s.signer.SignCommittee(
		jobID, inputHash, operators, uint16(m), uint64(job.Deadline), amount, bondBig, new(big.Int).SetUint64(nonce))
	if err != nil {
		return nil, fmt.Errorf("dispatch: sign committee: %w", err)
	}

	ca := queue.CommitteeAssignment{
		Operators:       signed.Operators,
		OperatorSetRoot: signed.OperatorSetRoot,
		InputHash:       inputHash,
		AssignmentSig:   signed.Signature,
		Nonce:           nonce,
		Bond:            bond,
	}
	s.mu.Lock()
	s.pending[jobID] = ca
	s.mu.Unlock()

	return &Result{
		Operators:       signed.Operators,
		OperatorSetRoot: signed.OperatorSetRoot,
		AssignmentSig:   signed.Signature,
		InputHash:       inputHash,
		Nonce:           nonce,
		Bond:            bond,
		Amount:          job.AmountUsdc,
		Deadline:        job.Deadline,
		Redundancy:      m,
	}, nil
}

// Activate records the stashed committee on a job that is now escrowed (Escrowed → Matched), so its
// members can pull. No-op (nil error) if there is no pending committee or the job is already
// activated; returns ErrConflict only for an unexpected queue state.
func (s *Service) Activate(ctx context.Context, jobID domain.Hex) error {
	s.mu.Lock()
	ca, ok := s.pending[jobID]
	s.mu.Unlock()
	if !ok {
		return nil // nothing signed for this job
	}
	job, err := s.q.Get(ctx, jobID)
	if err != nil {
		return err
	}
	if len(job.Operators) > 0 {
		// Already activated (e.g. a duplicate trigger). Clear the stash and stop.
		s.clearPending(jobID)
		return nil
	}
	if job.Status != domain.StatusEscrowed {
		return nil // not escrowed yet — try again on the next sweep
	}
	if _, err := s.q.AssignCommittee(ctx, jobID, ca); err != nil {
		return fmt.Errorf("dispatch: activate %s: %w", jobID, err)
	}
	s.clearPending(jobID)
	return nil
}

// ActivatePending sweeps every signed-but-not-yet-activated job and activates those now escrowed,
// returning how many it activated. Call on a ticker, or react to the indexer's JobEscrowed.
func (s *Service) ActivatePending(ctx context.Context) (int, error) {
	s.mu.Lock()
	ids := make([]domain.Hex, 0, len(s.pending))
	for id := range s.pending {
		ids = append(ids, id)
	}
	s.mu.Unlock()

	activated := 0
	for _, id := range ids {
		before := s.hasPending(id)
		if err := s.Activate(ctx, id); err != nil {
			return activated, err
		}
		if before && !s.hasPending(id) {
			activated++
		}
	}
	return activated, nil
}

func (s *Service) clearPending(jobID domain.Hex) {
	s.mu.Lock()
	delete(s.pending, jobID)
	s.mu.Unlock()
}

func (s *Service) hasPending(jobID domain.Hex) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.pending[jobID]
	return ok
}
