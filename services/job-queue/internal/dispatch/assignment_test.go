package dispatch

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/orchestrator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/presence"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
)

const (
	settlement = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3"
	op0        = "0x1111111111111111111111111111111111111111"
	op1        = "0x2222222222222222222222222222222222222222"
	op2        = "0x3333333333333333333333333333333333333333"
	// jid is a valid bytes32 jobId (the signer decodes it as bytes32, like an on-chain keccak id).
	jid = domain.Hex("0x" + "0101010101010101010101010101010101010101010101010101010101010101")
)

func testSigner(t *testing.T) *orchestrator.Signer {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = 0x11
	}
	s, err := orchestrator.NewSigner(secp256k1.PrivKeyFromBytes(key), big.NewInt(31337), settlement)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func node(id string) domain.NodeProfile {
	return domain.NodeProfile{NodeID: domain.Address(id), CpuCores: 8, RamGb: 32, Region: "us-east", ReliabilityScore: 0.9}
}

func intp(i int) *int { return &i }

func redundantJob(id string, m int) domain.Job {
	return domain.Job{
		JobID: domain.Hex(id), Buyer: "0xbuyer", AmountUsdc: "100000000", Deadline: 9000,
		Status:       domain.StatusEscrowed,
		Requirements: domain.JobRequirements{JobType: domain.JobGeneralCompute, EstimatedDurationSec: 60, Redundancy: intp(m)},
	}
}

func TestPrepareAndSign_thenActivate(t *testing.T) {
	ctx := context.Background()
	q := queue.NewMemory(func() int64 { return 1000 }, matching.Weights{})
	reg := presence.NewRegistry()
	reg.Add(node(op0))
	reg.Add(node(op1))
	reg.Add(node(op2))
	svc := New(q, testSigner(t), reg, nil, matching.Weights{}, func() int64 { return 1000 })

	if err := q.Enqueue(ctx, redundantJob(jid, 3)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	res, err := svc.PrepareAndSign(ctx, jid, domain.Hex("0x"+repeat("ab", 32)), "10000000")
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if len(res.Operators) != 3 || res.Redundancy != 3 || res.Nonce != 1 || res.AssignmentSig == "" {
		t.Fatalf("bad result: %+v", res)
	}
	// The signature must recover to the orchestrator (i.e. the contract would accept it).
	a := orchestrator.Assignment{
		JobID: jid, InputHash: res.InputHash, OperatorSetRoot: res.OperatorSetRoot, Redundancy: 3,
		Deadline: 9000, Amount: big.NewInt(100000000), Bond: big.NewInt(10000000), Nonce: big.NewInt(1),
	}
	digest, _ := a.Digest(big.NewInt(31337), settlement)
	signer, _ := orchestrator.Recover(digest, res.AssignmentSig)
	if !eqFold(signer, svc.signer.Address()) {
		t.Fatalf("signature does not recover to orchestrator: %s vs %s", signer, svc.signer.Address())
	}

	// Before activation the job has no committee recorded.
	if j, _ := q.Get(ctx, jid); len(j.Operators) != 0 {
		t.Fatalf("committee should not be recorded pre-activation")
	}

	// Activate (job is escrowed) → committee recorded, job Matched, members can pull.
	if err := svc.Activate(ctx, jid); err != nil {
		t.Fatalf("activate: %v", err)
	}
	j, _ := q.Get(ctx, jid)
	if j.Status != domain.StatusMatched || len(j.Operators) != 3 || j.OperatorSetRoot != res.OperatorSetRoot {
		t.Fatalf("committee not activated: %+v", j)
	}
	if _, err := q.FindCommitteeJob(ctx, op0); err != nil {
		t.Fatalf("member should find its committee job: %v", err)
	}
}

func TestActivatePending_onlyWhenEscrowed(t *testing.T) {
	ctx := context.Background()
	q := queue.NewMemory(func() int64 { return 1000 }, matching.Weights{})
	reg := presence.NewRegistry()
	reg.Add(node(op0))
	reg.Add(node(op1))
	reg.Add(node(op2))
	svc := New(q, testSigner(t), reg, nil, matching.Weights{}, func() int64 { return 1000 })

	// Job starts as submitted (pre-escrow): sign now, but activation must wait for escrow.
	j := redundantJob(jid, 3)
	j.Status = domain.StatusSubmitted
	_ = q.Enqueue(ctx, j)
	if _, err := svc.PrepareAndSign(ctx, jid, domain.Hex("0x"+repeat("cd", 32)), "10000000"); err != nil {
		t.Fatalf("prepare: %v", err)
	}

	n, err := svc.ActivatePending(ctx)
	if err != nil || n != 0 {
		t.Fatalf("submitted job must not activate: n=%d err=%v", n, err)
	}
	// Escrow the job, then the sweep activates it.
	if _, err := q.Transition(ctx, jid, domain.StatusEscrowed); err != nil {
		t.Fatalf("escrow: %v", err)
	}
	n, err = svc.ActivatePending(ctx)
	if err != nil || n != 1 {
		t.Fatalf("escrowed job should activate once: n=%d err=%v", n, err)
	}
	if j, _ := q.Get(ctx, jid); j.Status != domain.StatusMatched {
		t.Fatalf("status=%s, want matched", j.Status)
	}
}

func TestPrepareAndSign_insufficientNodes(t *testing.T) {
	ctx := context.Background()
	q := queue.NewMemory(func() int64 { return 1000 }, matching.Weights{})
	reg := presence.NewRegistry()
	reg.Add(node(op0))
	reg.Add(node(op1)) // only 2 connected, job needs 3
	svc := New(q, testSigner(t), reg, nil, matching.Weights{}, func() int64 { return 1000 })
	_ = q.Enqueue(ctx, redundantJob(jid, 3))

	if _, err := svc.PrepareAndSign(ctx, jid, domain.Hex("0x"+repeat("ef", 32)), "10000000"); !errors.Is(err, ErrInsufficientNodes) {
		t.Fatalf("expected ErrInsufficientNodes, got %v", err)
	}
}

func TestPrepareAndSign_stakeFilterApplied(t *testing.T) {
	ctx := context.Background()
	q := queue.NewMemory(func() int64 { return 1000 }, matching.Weights{})
	reg := presence.NewRegistry()
	reg.Add(node(op0))
	reg.Add(node(op1))
	reg.Add(node(op2))
	// op1 is under-bonded → only 2 stakeable nodes, can't seat a committee of 3.
	stake := matching.MapStakeOracle{op0: 10_000_000, op1: 1, op2: 50_000_000}
	svc := New(q, testSigner(t), reg, stake, matching.Weights{}, func() int64 { return 1000 })
	_ = q.Enqueue(ctx, redundantJob(jid, 3))

	if _, err := svc.PrepareAndSign(ctx, jid, domain.Hex("0x"+repeat("11", 32)), "10000000"); !errors.Is(err, ErrInsufficientNodes) {
		t.Fatalf("under-bonded committee should fail: %v", err)
	}
}

// --- tiny local helpers (avoid importing strings/encoding in a focused test) ---

func repeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}

func eqFold(a, b domain.Address) bool {
	return toLower(string(a)) == toLower(string(b))
}

func toLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'F' {
			b[i] = c + 32
		}
	}
	return string(b)
}
