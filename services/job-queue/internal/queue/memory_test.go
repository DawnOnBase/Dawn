package queue

import (
	"context"
	"errors"
	"testing"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
)

func intp(i int) *int { return &i }

func fixedClock(t int64) Clock { return func() int64 { return t } }

func cpuNode() domain.NodeProfile {
	return domain.NodeProfile{NodeID: "0xnode", CpuCores: 8, RamGb: 32, Region: "us-east", ReliabilityScore: 0.9}
}

func escrowedJob(id, amount string, deadline int64) domain.Job {
	return domain.Job{
		JobID:      id,
		Buyer:      "0xbuyer",
		AmountUsdc: amount,
		Deadline:   deadline,
		Status:     domain.StatusEscrowed,
		Requirements: domain.JobRequirements{
			JobType: domain.JobGeneralCompute, MinCpuCores: intp(2), EstimatedDurationSec: 60,
		},
	}
}

func TestEnqueueAndGet(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	j := escrowedJob("j1", "1000000", 5000)
	if err := q.Enqueue(ctx, j); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// duplicate rejected
	if err := q.Enqueue(ctx, j); !errors.Is(err, ErrConflict) {
		t.Errorf("expected ErrConflict on duplicate, got %v", err)
	}
	got, err := q.Get(ctx, "j1")
	if err != nil || got.JobID != "j1" {
		t.Fatalf("get: %v %+v", err, got)
	}
	if _, err := q.Get(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestEnqueueRejectsBadStatus(t *testing.T) {
	q := NewMemory(fixedClock(0), matching.Weights{})
	j := escrowedJob("j", "1", 100)
	j.Status = domain.StatusSettled
	if err := q.Enqueue(context.Background(), j); !errors.Is(err, ErrConflict) {
		t.Errorf("expected ErrConflict for settled enqueue, got %v", err)
	}
}

func TestClaim_AssignsBestAndMatches(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	_ = q.Enqueue(ctx, escrowedJob("low", "1000000", 9000))
	_ = q.Enqueue(ctx, escrowedJob("high", "8000000", 9000))

	claimed, err := q.Claim(ctx, cpuNode())
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if claimed.JobID != "high" {
		t.Errorf("expected highest-pay job claimed, got %s", claimed.JobID)
	}
	if claimed.Status != domain.StatusMatched {
		t.Errorf("claimed job should be matched, got %s", claimed.Status)
	}
	if claimed.Operator == nil || *claimed.Operator != "0xnode" {
		t.Errorf("operator should be set to node, got %v", claimed.Operator)
	}

	// second claim gets the remaining job; third finds nothing.
	if _, err := q.Claim(ctx, cpuNode()); err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if _, err := q.Claim(ctx, cpuNode()); !errors.Is(err, ErrNoJob) {
		t.Errorf("expected ErrNoJob, got %v", err)
	}
}

func TestTransition_HappyAndIllegal(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	_ = q.Enqueue(ctx, escrowedJob("j", "1000000", 9000))
	if _, err := q.Claim(ctx, cpuNode()); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Transition(ctx, "j", domain.StatusRunning); err != nil {
		t.Fatalf("matched→running should work: %v", err)
	}
	if _, err := q.Transition(ctx, "j", domain.StatusSettled); !errors.Is(err, ErrConflict) {
		t.Errorf("running→settled is illegal, want ErrConflict, got %v", err)
	}
	if _, err := q.Transition(ctx, "missing", domain.StatusFailed); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}

func TestRequeue_ClearsOperator(t *testing.T) {
	q := NewMemory(fixedClock(1000), matching.Weights{})
	ctx := context.Background()
	_ = q.Enqueue(ctx, escrowedJob("j", "1000000", 9000))
	_, _ = q.Claim(ctx, cpuNode())
	if err := q.Requeue(ctx, "j"); err != nil {
		t.Fatalf("requeue: %v", err)
	}
	j, _ := q.Get(ctx, "j")
	if j.Status != domain.StatusEscrowed || j.Operator != nil {
		t.Errorf("requeued job should be escrowed with no operator, got %s op=%v", j.Status, j.Operator)
	}
	// and is claimable again
	if _, err := q.Claim(ctx, cpuNode()); err != nil {
		t.Errorf("requeued job should be claimable: %v", err)
	}
}

func TestSweepTimeouts(t *testing.T) {
	q := NewMemory(fixedClock(10_000), matching.Weights{})
	ctx := context.Background()
	_ = q.Enqueue(ctx, escrowedJob("past", "1000000", 5000))     // deadline < now -> swept
	_ = q.Enqueue(ctx, escrowedJob("future", "1000000", 50_000)) // deadline > now -> kept

	n, err := q.SweepTimeouts(ctx, 10_000)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 swept, got %d", n)
	}
	past, _ := q.Get(ctx, "past")
	if past.Status != domain.StatusTimedOut {
		t.Errorf("past job should be timed_out, got %s", past.Status)
	}
	future, _ := q.Get(ctx, "future")
	if future.Status != domain.StatusEscrowed {
		t.Errorf("future job should still be escrowed, got %s", future.Status)
	}
}
