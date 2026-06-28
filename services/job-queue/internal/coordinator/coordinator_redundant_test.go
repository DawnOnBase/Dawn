package coordinator

import (
	"context"
	"encoding/hex"
	"math/big"
	"testing"

	"golang.org/x/crypto/sha3"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/orchestrator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/protocol"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
)

// Local mirror of the contract's sorted-pair keccak Merkle fold, so the test verifies the proof the
// coordinator hands out is the one Settlement._verifyMembership would accept.
func kec(b []byte) []byte { h := sha3.NewLegacyKeccak256(); h.Write(b); return h.Sum(nil) }

func keccak20(b []byte) []byte { return kec(b) }

func hashPairLE(a, b []byte) []byte {
	if new(big.Int).SetBytes(a).Cmp(new(big.Int).SetBytes(b)) <= 0 {
		return kec(append(append([]byte{}, a...), b...))
	}
	return kec(append(append([]byte{}, b...), a...))
}

// Real 20-byte addresses so orchestrator.MerkleProof can decode them.
const (
	rop0 = "0x1111111111111111111111111111111111111111"
	rop1 = "0x2222222222222222222222222222222222222222"
	rop2 = "0x3333333333333333333333333333333333333333"
)

// seedRedundant enqueues an M=3 redundant job, assigns the {rop0,rop1,rop2} committee with the REAL
// Merkle root, and returns that root so the test can verify each member's returned proof.
func seedRedundant(t *testing.T, h *harness) domain.Hex {
	t.Helper()
	ctx := context.Background()
	m := 3
	job := domain.Job{
		JobID: "r1", Buyer: "0xbuyer", AmountUsdc: "100000000", Deadline: 9000,
		Status:       domain.StatusEscrowed,
		Requirements: domain.JobRequirements{JobType: domain.JobGeneralCompute, EstimatedDurationSec: 60, Redundancy: &m},
	}
	if err := h.q.Enqueue(ctx, job); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	h.inputs.Set("r1", "ipfs://r1")
	ops := []domain.Address{rop0, rop1, rop2}
	root, err := orchestrator.MerkleRoot(ops)
	if err != nil {
		t.Fatalf("root: %v", err)
	}
	if _, err := h.q.AssignCommittee(ctx, "r1", queue.CommitteeAssignment{
		Operators: ops, OperatorSetRoot: root, InputHash: "0xinput", AssignmentSig: "0xsig", Nonce: 7, Bond: "10000000",
	}); err != nil {
		t.Fatalf("assign committee: %v", err)
	}
	return root
}

func helloAs(t *testing.T, h *harness, nodeID domain.Address) *Session {
	t.Helper()
	s := &Session{}
	prof := domain.NodeProfile{NodeID: nodeID, CpuCores: 8, RamGb: 32, Region: "us-east", ReliabilityScore: 0.9}
	if _, err := h.coord.Handle(context.Background(), s, protocol.AgentToBackend{
		T: protocol.MsgHello, NodeID: nodeID, Sig: "0xsig", Profile: &prof,
	}); err != nil {
		t.Fatalf("hello %s: %v", nodeID, err)
	}
	return s
}

// foldProof re-folds a member's sorted-pair Merkle proof to the root, the same fold
// Settlement._verifyMembership performs on-chain.
func foldProof(t *testing.T, op domain.Address, proof []domain.Hex) domain.Hex {
	t.Helper()
	cur, err := hex.DecodeString(op[2:])
	if err != nil {
		t.Fatal(err)
	}
	cur = keccak20(cur)
	for _, p := range proof {
		pb, _ := hex.DecodeString(string(p)[2:])
		cur = hashPairLE(cur, pb)
	}
	return domain.Hex("0x" + hex.EncodeToString(cur))
}

func TestRedundant_eachMemberPullsAuthorizedAssignment(t *testing.T) {
	h := newHarness(t)
	root := seedRedundant(t, h)
	ctx := context.Background()

	for _, op := range []domain.Address{rop0, rop1, rop2} {
		s := helloAs(t, h, op)
		reply, err := h.coord.Handle(ctx, s, protocol.AgentToBackend{T: protocol.MsgPullJob})
		if err != nil {
			t.Fatalf("pull %s: %v", op, err)
		}
		if reply == nil || reply.T != protocol.MsgJobAssignment || reply.JobID != "r1" {
			t.Fatalf("expected redundant job_assignment, got %+v", reply)
		}
		if reply.Redundancy != 3 || reply.OperatorSetRoot != root || reply.AssignmentSig != "0xsig" ||
			reply.Nonce != 7 || reply.Bond != "10000000" {
			t.Fatalf("redundant fields wrong: %+v", reply)
		}
		// The returned membership proof must fold to the committed root (what the contract checks).
		if got := foldProof(t, op, reply.MerkleProof); got != root {
			t.Fatalf("member %s proof folds to %s, want root %s", op, got, root)
		}
	}
}

func TestRedundant_quorumForwardsRealMAndFlipsProven(t *testing.T) {
	h := newHarness(t)
	seedRedundant(t, h)
	ctx := context.Background()
	s0 := helloAs(t, h, rop0)
	s1 := helloAs(t, h, rop1)

	submit := func(s *Session, op domain.Address) (*protocol.BackendToAgent, error) {
		proof := &domain.ProofBundle{JobID: "r1", InputHash: "0xinput", OutputHash: "0xWIN", Metadata: "0x", NodeSignature: "0x" + string(op[2:])}
		return h.coord.Handle(ctx, s, protocol.AgentToBackend{T: protocol.MsgSubmitResult, Proof: proof, ResultRef: "ipfs://out"})
	}

	// First submission: below quorum(3)=2 → job stays Matched, proof forwarded with the REAL M=3.
	if _, err := submit(s0, rop0); err != nil {
		t.Fatalf("submit op0: %v", err)
	}
	if j, _ := h.q.Get(ctx, "r1"); j.Status != domain.StatusMatched {
		t.Fatalf("after 1 submit status=%s, want matched (below quorum)", j.Status)
	}
	if len(h.sunk) != 1 || h.sunk[0].redundancy != 3 {
		t.Fatalf("proof must forward with redundancy 3, got %+v", h.sunk)
	}

	// Second submission reaches quorum → job flips to Proven.
	if _, err := submit(s1, rop1); err != nil {
		t.Fatalf("submit op1: %v", err)
	}
	if j, _ := h.q.Get(ctx, "r1"); j.Status != domain.StatusProven {
		t.Fatalf("after quorum status=%s, want proven", j.Status)
	}
}

func TestRedundant_doubleSubmitAndNonMemberRejected(t *testing.T) {
	h := newHarness(t)
	seedRedundant(t, h)
	ctx := context.Background()
	s0 := helloAs(t, h, rop0)

	proof := &domain.ProofBundle{JobID: "r1", InputHash: "0xinput", OutputHash: "0xWIN", NodeSignature: "0xa"}
	if _, err := h.coord.Handle(ctx, s0, protocol.AgentToBackend{T: protocol.MsgSubmitResult, Proof: proof, ResultRef: "r"}); err != nil {
		t.Fatalf("first submit: %v", err)
	}
	// Same operator submitting twice is rejected (one slot per operator).
	if _, err := h.coord.Handle(ctx, s0, protocol.AgentToBackend{T: protocol.MsgSubmitResult, Proof: proof, ResultRef: "r"}); err == nil {
		t.Fatal("expected double-submit to be rejected")
	}

	// A node that is NOT in the committee cannot submit for the job.
	sStranger := helloAs(t, h, "0x9999999999999999999999999999999999999999")
	if _, err := h.coord.Handle(ctx, sStranger, protocol.AgentToBackend{T: protocol.MsgSubmitResult, Proof: proof, ResultRef: "r"}); err == nil {
		t.Fatal("expected non-member submit to be rejected")
	}
}
