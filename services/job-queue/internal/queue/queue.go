// Package queue is the durable job queue abstraction .
// The interface is storage-agnostic: an in-memory implementation backs tests
// and local dev, and a Postgres implementation (FOR UPDATE SKIP LOCKED) backs
// production. All status changes go through internal/statemachine.
package queue

import (
	"context"
	"errors"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

var (
	// ErrNoJob is returned by Claim when no eligible job is available.
	ErrNoJob = errors.New("queue: no eligible job")
	// ErrNotFound is returned when a jobId is unknown.
	ErrNotFound = errors.New("queue: job not found")
	// ErrConflict is returned for an illegal state transition or lost race.
	ErrConflict = errors.New("queue: conflicting state")
)

// Queue is the durable, ordered task-distribution layer.
type Queue interface {
	// Enqueue stores a new job. The job's Status must be Submitted or Escrowed.
	Enqueue(ctx context.Context, job domain.Job) error

	// Get returns a job by id, or ErrNotFound.
	Get(ctx context.Context, jobID domain.Hex) (domain.Job, error)

	// Claim atomically assigns the best eligible Escrowed job to the node and
	// transitions it to Matched (operator = node.NodeID). Returns ErrNoJob if
	// nothing matches. This is the agent `pull_job` path.
	Claim(ctx context.Context, node domain.NodeProfile) (domain.Job, error)

	// Transition validates current→to via the state machine and persists it.
	// Returns ErrConflict if the transition is illegal or the job moved.
	Transition(ctx context.Context, jobID domain.Hex, to domain.JobStatus) (domain.Job, error)

	// RecordResult stores a job's off-chain result ref + proof outputHash (written
	// when the node submits its result), which the API's GET /result reads back.
	// Idempotent (last write wins). Returns ErrNotFound for an unknown job.
	RecordResult(ctx context.Context, jobID domain.Hex, resultRef, outputHash string) error

	// Requeue returns a Matched/Running job to Escrowed (assigned node dropped),
	// clearing the operator so it can be re-matched.
	Requeue(ctx context.Context, jobID domain.Hex) error

	// SweepTimeouts transitions non-terminal jobs whose deadline < now to
	// TimedOut, returning how many were swept.
	SweepTimeouts(ctx context.Context, now int64) (int, error)

	// List returns jobs in the given status (admin/tests; may be unordered).
	List(ctx context.Context, status domain.JobStatus) ([]domain.Job, error)

	// AssignCommittee pre-assigns a redundant job to its orchestrator-signed M-operator committee
	// (M9 doc #4). It records the Assignment (operators, root, sig, nonce, bond, inputHash) on
	// the job and transitions Escrowed → Matched so the single-node Claim path will not also hand it
	// out. Unlike Claim it sets Operators (not Operator) — all M members run it. Returns ErrNotFound
	// for an unknown job, or ErrConflict if the job is not an Escrowed redundant job.
	AssignCommittee(ctx context.Context, jobID domain.Hex, a CommitteeAssignment) (domain.Job, error)

	// FindCommitteeJob returns a pre-assigned redundant job for which nodeID is an authorized,
	// not-yet-submitted committee member, or ErrNoJob. It does NOT mutate the job (membership is
	// fixed at assignment), so all M members can each pull the same job — the redundant analog of
	// Claim. Only Matched/Running jobs are eligible.
	FindCommitteeJob(ctx context.Context, nodeID domain.Address) (domain.Job, error)

	// RecordCommitteeSubmission records that `operator` submitted its proof for a redundant job and
	// returns the number of DISTINCT operators that have now submitted. It enforces one slot per
	// operator: ErrConflict if the operator already submitted, or is not in the job's committee.
	RecordCommitteeSubmission(ctx context.Context, jobID domain.Hex, operator domain.Address) (int, error)
}

// CommitteeAssignment is the orchestrator-signed authorization AssignCommittee records on a job. It
// maps 1:1 onto the redundant fields of domain.Job and the escrowRedundant calldata. The operator
// order is canonical (the Merkle proofs are built against it) and MUST be preserved.
type CommitteeAssignment struct {
	Operators       []domain.Address
	OperatorSetRoot domain.Hex
	InputHash       domain.Hex
	AssignmentSig   domain.Hex
	Nonce           uint64
	Bond            string
}

// Clock returns the current unix time in seconds. Injected for testability.
type Clock func() int64
