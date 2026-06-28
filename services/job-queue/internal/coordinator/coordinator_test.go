package coordinator

import (
	"context"
	"errors"
	"testing"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/protocol"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
)

func intp(i int) *int { return &i }

type sunk struct {
	proof       domain.ProofBundle
	redundancy  int
	merkleProof []domain.Hex
}

type harness struct {
	q       *queue.Memory
	inputs  *MapInputResolver
	proofs  []domain.ProofBundle
	sunk    []sunk
	coord   *Coordinator
	session *Session
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	q := queue.NewMemory(func() int64 { return 1000 }, matching.Weights{})
	inputs := NewMapInputResolver()
	h := &harness{q: q, inputs: inputs, session: &Session{}}
	sink := ProofSinkFunc(func(_ context.Context, s ProofSubmission) error {
		h.proofs = append(h.proofs, s.Proof)
		h.sunk = append(h.sunk, sunk{proof: s.Proof, redundancy: s.Redundancy, merkleProof: s.MerkleProof})
		return nil
	})
	h.coord = New(q, AllowAllAuth{}, inputs, sink, func() int64 { return 1000 })
	return h
}

func seedJob(h *harness, id string) {
	job := domain.Job{
		JobID: id, Buyer: "0xbuyer", AmountUsdc: "5000000", Deadline: 9000, Status: domain.StatusEscrowed,
		Requirements: domain.JobRequirements{JobType: domain.JobGeneralCompute, MinCpuCores: intp(2), EstimatedDurationSec: 60},
	}
	_ = h.q.Enqueue(context.Background(), job)
	h.inputs.Set(id, "ipfs://input/"+id)
}

func hello(h *harness) {
	prof := domain.NodeProfile{NodeID: "0xnode", CpuCores: 8, RamGb: 32, Region: "us-east", ReliabilityScore: 0.9}
	_, err := h.coord.Handle(context.Background(), h.session, protocol.AgentToBackend{
		T: protocol.MsgHello, NodeID: "0xnode", Sig: "0xsig", Profile: &prof,
	})
	if err != nil {
		panic(err)
	}
}

func TestPullBeforeHello_Unauthenticated(t *testing.T) {
	h := newHarness(t)
	_, err := h.coord.Handle(context.Background(), h.session, protocol.AgentToBackend{T: protocol.MsgPullJob})
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated, got %v", err)
	}
}

func TestFullLifecycle(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	hello(h)
	seedJob(h, "j1")

	// pull -> assignment with input ref
	reply, err := h.coord.Handle(ctx, h.session, protocol.AgentToBackend{T: protocol.MsgPullJob})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if reply == nil || reply.T != protocol.MsgJobAssignment {
		t.Fatalf("expected job_assignment, got %+v", reply)
	}
	if reply.JobID != "j1" || reply.InputRef != "ipfs://input/j1" {
		t.Fatalf("bad assignment: %+v", reply)
	}
	if h.session.CurrentJob != "j1" {
		t.Fatalf("session should track current job")
	}

	// heartbeat -> job moves matched -> running
	if _, err := h.coord.Handle(ctx, h.session, protocol.AgentToBackend{T: protocol.MsgHeartbeat, Ts: 1100}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if j, _ := h.q.Get(ctx, "j1"); j.Status != domain.StatusRunning {
		t.Fatalf("job should be running after heartbeat, got %s", j.Status)
	}

	// submit_result -> proven, proof handed to sink, ack returned
	proof := &domain.ProofBundle{JobID: "j1", InputHash: "0xin", OutputHash: "0xout", Metadata: "0x", NodeSignature: "0xsig"}
	reply, err = h.coord.Handle(ctx, h.session, protocol.AgentToBackend{T: protocol.MsgSubmitResult, Proof: proof, ResultRef: "ipfs://out/j1"})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if reply == nil || reply.T != protocol.MsgAck || reply.JobID != "j1" {
		t.Fatalf("expected ack for j1, got %+v", reply)
	}
	if j, _ := h.q.Get(ctx, "j1"); j.Status != domain.StatusProven {
		t.Fatalf("job should be proven, got %s", j.Status)
	}
	// The result + attestation must be persisted for the buyer's GET /result.
	if ref, oh, ok := h.q.ResultFor("j1"); !ok || ref != "ipfs://out/j1" || oh != "0xout" {
		t.Fatalf("result should be recorded: ref=%q outputHash=%q ok=%v", ref, oh, ok)
	}
	if len(h.proofs) != 1 || h.proofs[0].JobID != "j1" {
		t.Fatalf("proof should have been handed to sink, got %+v", h.proofs)
	}
	if h.session.CurrentJob != "" {
		t.Fatalf("session current job should be cleared after submit")
	}
}

func TestDisconnectRequeuesInFlightJob(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	seedJob(h, "j1")
	hello(h)

	// pull -> j1 assigned to this node (matched).
	if _, err := h.coord.Handle(ctx, h.session, protocol.AgentToBackend{T: protocol.MsgPullJob}); err != nil {
		t.Fatalf("pull: %v", err)
	}
	if h.session.CurrentJob != "j1" {
		t.Fatalf("expected j1 assigned, got %q", h.session.CurrentJob)
	}

	// Node drops mid-job: the job must return to escrowed (re-matchable), not strand.
	h.coord.Disconnect(ctx, h.session)
	j, _ := h.q.Get(ctx, "j1")
	if j.Status != domain.StatusEscrowed {
		t.Fatalf("dropped node's job should be requeued to escrowed, got %s", j.Status)
	}
	if j.Operator != nil {
		t.Fatalf("operator should be cleared on requeue, got %v", *j.Operator)
	}
	if h.session.CurrentJob != "" {
		t.Fatalf("session current job should be cleared")
	}
}

func TestPullNoJob(t *testing.T) {
	h := newHarness(t)
	hello(h)
	reply, err := h.coord.Handle(context.Background(), h.session, protocol.AgentToBackend{T: protocol.MsgPullJob})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if reply == nil || reply.T != protocol.MsgNoJob {
		t.Fatalf("expected no_job, got %+v", reply)
	}
}

func TestSubmitForeignJob_Rejected(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	hello(h)
	seedJob(h, "j1")
	// someone else's node claimed j1
	_, _ = h.q.Claim(ctx, domain.NodeProfile{NodeID: "0xother", CpuCores: 8, RamGb: 32})

	proof := &domain.ProofBundle{JobID: "j1", OutputHash: "0xout"}
	_, err := h.coord.Handle(ctx, h.session, protocol.AgentToBackend{T: protocol.MsgSubmitResult, Proof: proof})
	if err == nil {
		t.Fatal("expected rejection submitting for a job owned by another node")
	}
}
