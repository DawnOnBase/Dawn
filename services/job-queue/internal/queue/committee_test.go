package queue

import (
	"context"
	"errors"
	"testing"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
)

func redundantJob(id string, m int, deadline int64) domain.Job {
	j := escrowedJob(id, "100000000", deadline)
	j.Requirements.Redundancy = intp(m)
	return j
}

func sampleAssignment() CommitteeAssignment {
	return CommitteeAssignment{
		Operators:       []domain.Address{"0xop0", "0xop1", "0xop2"},
		OperatorSetRoot: "0xroot",
		InputHash:       "0xinput",
		AssignmentSig:   "0xsig",
		Nonce:           7,
		Bond:            "10000000",
	}
}

func TestAssignCommittee_storesAssignmentAndMatches(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	if err := q.Enqueue(ctx, redundantJob("r1", 3, 9000)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	j, err := q.AssignCommittee(ctx, "r1", sampleAssignment())
	if err != nil {
		t.Fatalf("assign: %v", err)
	}
	if j.Status != domain.StatusMatched {
		t.Fatalf("status = %s, want matched", j.Status)
	}
	if len(j.Operators) != 3 || j.OperatorSetRoot != "0xroot" || j.Nonce != 7 || j.Bond != "10000000" {
		t.Fatalf("assignment not stored: %+v", j)
	}
	// Operator (single-node slot) must stay empty so Disconnect never requeues a shared committee job.
	if j.Operator != nil {
		t.Fatalf("redundant job must not set single Operator, got %v", *j.Operator)
	}
}

func TestAssignCommittee_rejectsNonRedundantOrNonEscrowed(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()

	// Single-node job (no redundancy) cannot be committee-assigned.
	_ = q.Enqueue(ctx, escrowedJob("s1", "1", 9000))
	if _, err := q.AssignCommittee(ctx, "s1", sampleAssignment()); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict for single-node job, got %v", err)
	}

	// Unknown job.
	if _, err := q.AssignCommittee(ctx, "nope", sampleAssignment()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	// Already-assigned (Matched) job cannot be re-assigned.
	_ = q.Enqueue(ctx, redundantJob("r1", 3, 9000))
	if _, err := q.AssignCommittee(ctx, "r1", sampleAssignment()); err != nil {
		t.Fatalf("first assign: %v", err)
	}
	if _, err := q.AssignCommittee(ctx, "r1", sampleAssignment()); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict on re-assign, got %v", err)
	}
}

func TestFindCommitteeJob_membersPullSameJob(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	_ = q.Enqueue(ctx, redundantJob("r1", 3, 9000))
	if _, err := q.AssignCommittee(ctx, "r1", sampleAssignment()); err != nil {
		t.Fatalf("assign: %v", err)
	}

	// All three members find the SAME job — FindCommitteeJob does not mutate/consume it.
	for _, op := range []domain.Address{"0xop0", "0xop1", "0xop2"} {
		j, err := q.FindCommitteeJob(ctx, op)
		if err != nil || j.JobID != "r1" {
			t.Fatalf("member %s should find r1: job=%+v err=%v", op, j, err)
		}
	}
	// A non-member gets nothing.
	if _, err := q.FindCommitteeJob(ctx, "0xstranger"); !errors.Is(err, ErrNoJob) {
		t.Fatalf("non-member should get ErrNoJob, got %v", err)
	}
}

func TestRecordCommitteeSubmission_oneSlotPerOperator(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	_ = q.Enqueue(ctx, redundantJob("r1", 3, 9000))
	_, _ = q.AssignCommittee(ctx, "r1", sampleAssignment())

	n, err := q.RecordCommitteeSubmission(ctx, "r1", "0xop0")
	if err != nil || n != 1 {
		t.Fatalf("first submission: n=%d err=%v", n, err)
	}
	// Same operator again → rejected, count unchanged.
	if _, err := q.RecordCommitteeSubmission(ctx, "r1", "0xop0"); !errors.Is(err, ErrConflict) {
		t.Fatalf("double-submit should be ErrConflict, got %v", err)
	}
	// A second distinct operator advances the count.
	n, err = q.RecordCommitteeSubmission(ctx, "r1", "0xop1")
	if err != nil || n != 2 {
		t.Fatalf("second operator: n=%d err=%v", n, err)
	}
	// A non-member cannot submit.
	if _, err := q.RecordCommitteeSubmission(ctx, "r1", "0xstranger"); !errors.Is(err, ErrConflict) {
		t.Fatalf("non-member submit should be ErrConflict, got %v", err)
	}
}

func TestFindCommitteeJob_skipsAlreadySubmitted(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	_ = q.Enqueue(ctx, redundantJob("r1", 3, 9000))
	_, _ = q.AssignCommittee(ctx, "r1", sampleAssignment())

	if _, err := q.RecordCommitteeSubmission(ctx, "r1", "0xop0"); err != nil {
		t.Fatalf("record: %v", err)
	}
	// op0 already submitted → no longer pullable; op1 still is.
	if _, err := q.FindCommitteeJob(ctx, "0xop0"); !errors.Is(err, ErrNoJob) {
		t.Fatalf("submitted member should not re-pull, got %v", err)
	}
	if j, err := q.FindCommitteeJob(ctx, "0xop1"); err != nil || j.JobID != "r1" {
		t.Fatalf("un-submitted member should still pull: %+v %v", j, err)
	}
}
