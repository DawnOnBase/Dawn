package queue

import (
	"context"
	"sync"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/statemachine"
)

// Memory is an in-memory Queue for tests and local dev. Safe for concurrent use.
type Memory struct {
	mu      sync.Mutex
	jobs    map[domain.Hex]domain.Job
	results map[domain.Hex]resultRow
	// committeeSubs tracks which operators have submitted for a redundant job (one slot per
	// operator), so FindCommitteeJob can skip already-submitted members and quorum can be counted.
	committeeSubs map[domain.Hex]map[domain.Address]bool
	now           Clock
	weights       matching.Weights
}

type resultRow struct{ resultRef, outputHash string }

// NewMemory builds an in-memory queue. If clock is nil a zero clock is used
// (callers in tests should pass a fixed clock).
func NewMemory(clock Clock, w matching.Weights) *Memory {
	if clock == nil {
		clock = func() int64 { return 0 }
	}
	return &Memory{
		jobs:          make(map[domain.Hex]domain.Job),
		results:       make(map[domain.Hex]resultRow),
		committeeSubs: make(map[domain.Hex]map[domain.Address]bool),
		now:           clock,
		weights:       w,
	}
}

func (m *Memory) Enqueue(_ context.Context, job domain.Job) error {
	if job.Status != domain.StatusSubmitted && job.Status != domain.StatusEscrowed {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.jobs[job.JobID]; exists {
		return ErrConflict
	}
	m.jobs[job.JobID] = job
	return nil
}

func (m *Memory) Get(_ context.Context, jobID domain.Hex) (domain.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[jobID]
	if !ok {
		return domain.Job{}, ErrNotFound
	}
	return j, nil
}

func (m *Memory) Claim(_ context.Context, node domain.NodeProfile) (domain.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	escrowed := make([]domain.Job, 0)
	for _, j := range m.jobs {
		if j.Status == domain.StatusEscrowed {
			escrowed = append(escrowed, j)
		}
	}
	best := matching.BestJobForNode(node, escrowed, m.now(), m.weights)
	if best == nil {
		return domain.Job{}, ErrNoJob
	}

	next, err := statemachine.Transition(best.Status, domain.StatusMatched)
	if err != nil {
		return domain.Job{}, ErrConflict
	}
	best.Status = next
	op := node.NodeID
	best.Operator = &op
	m.jobs[best.JobID] = *best
	return *best, nil
}

func (m *Memory) Transition(_ context.Context, jobID domain.Hex, to domain.JobStatus) (domain.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[jobID]
	if !ok {
		return domain.Job{}, ErrNotFound
	}
	next, err := statemachine.Transition(j.Status, to)
	if err != nil {
		return domain.Job{}, ErrConflict
	}
	j.Status = next
	m.jobs[jobID] = j
	return j, nil
}

func (m *Memory) RecordResult(_ context.Context, jobID domain.Hex, resultRef, outputHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.jobs[jobID]; !ok {
		return ErrNotFound
	}
	m.results[jobID] = resultRow{resultRef: resultRef, outputHash: outputHash}
	return nil
}

// ResultFor returns a recorded result (test accessor; not part of Queue).
func (m *Memory) ResultFor(jobID domain.Hex) (resultRef, outputHash string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.results[jobID]
	return r.resultRef, r.outputHash, ok
}

func (m *Memory) Requeue(_ context.Context, jobID domain.Hex) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[jobID]
	if !ok {
		return ErrNotFound
	}
	next, err := statemachine.Transition(j.Status, domain.StatusEscrowed)
	if err != nil {
		return ErrConflict
	}
	j.Status = next
	j.Operator = nil
	m.jobs[jobID] = j
	return nil
}

func (m *Memory) SweepTimeouts(_ context.Context, now int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	swept := 0
	for id, j := range m.jobs {
		if statemachine.IsTerminal(j.Status) || j.Deadline >= now {
			continue
		}
		if !statemachine.CanTransition(j.Status, domain.StatusTimedOut) {
			continue
		}
		j.Status = domain.StatusTimedOut
		m.jobs[id] = j
		swept++
	}
	return swept, nil
}

func (m *Memory) List(_ context.Context, status domain.JobStatus) ([]domain.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]domain.Job, 0)
	for _, j := range m.jobs {
		if j.Status == status {
			out = append(out, j)
		}
	}
	return out, nil
}

func (m *Memory) AssignCommittee(_ context.Context, jobID domain.Hex, a CommitteeAssignment) (domain.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[jobID]
	if !ok {
		return domain.Job{}, ErrNotFound
	}
	if !j.IsRedundant() || j.Status != domain.StatusEscrowed || len(a.Operators) == 0 {
		return domain.Job{}, ErrConflict
	}
	next, err := statemachine.Transition(j.Status, domain.StatusMatched)
	if err != nil {
		return domain.Job{}, ErrConflict
	}
	j.Status = next
	j.Operators = append([]domain.Address(nil), a.Operators...)
	j.OperatorSetRoot = a.OperatorSetRoot
	j.InputHash = a.InputHash
	j.AssignmentSig = a.AssignmentSig
	j.Nonce = a.Nonce
	j.Bond = a.Bond
	m.jobs[jobID] = j
	return j, nil
}

func (m *Memory) FindCommitteeJob(_ context.Context, nodeID domain.Address) (domain.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		if !j.IsRedundant() || !j.InCommittee(nodeID) {
			continue
		}
		if j.Status != domain.StatusMatched && j.Status != domain.StatusRunning {
			continue
		}
		if m.committeeSubs[j.JobID][nodeID] {
			continue // this member already submitted
		}
		return j, nil
	}
	return domain.Job{}, ErrNoJob
}

func (m *Memory) RecordCommitteeSubmission(_ context.Context, jobID domain.Hex, operator domain.Address) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[jobID]
	if !ok {
		return 0, ErrNotFound
	}
	if !j.InCommittee(operator) {
		return 0, ErrConflict // not an authorized committee member
	}
	subs := m.committeeSubs[jobID]
	if subs == nil {
		subs = make(map[domain.Address]bool)
		m.committeeSubs[jobID] = subs
	}
	if subs[operator] {
		return len(subs), ErrConflict // one slot per operator
	}
	subs[operator] = true
	return len(subs), nil
}

// compile-time assertion that Memory implements Queue.
var _ Queue = (*Memory)(nil)
