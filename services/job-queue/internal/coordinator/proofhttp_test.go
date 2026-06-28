package coordinator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

func sampleProof() domain.ProofBundle {
	return domain.ProofBundle{
		JobID:         "0xjob",
		InputHash:     "0xin",
		OutputHash:    "0xout",
		Metadata:      "0x",
		NodeSignature: "0xsig",
	}
}

func TestProofServiceClient_PostsProof(t *testing.T) {
	var got proofSubmitBody
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/proofs" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type = %q", ct)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer srv.Close()

	c := NewProofServiceClient(srv.URL, nil)
	if err := c.Submit(context.Background(), ProofSubmission{Proof: sampleProof(), ResultRef: "echo://0xout", Redundancy: 3, MerkleProof: []domain.Hex{"0xaa", "0xbb"}}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if got.Proof.JobID != "0xjob" || got.Proof.OutputHash != "0xout" {
		t.Fatalf("proof not forwarded faithfully: %+v", got.Proof)
	}
	if got.Redundancy != 3 {
		t.Fatalf("redundancy = %d, want 3 (forwarded faithfully, not hardcoded)", got.Redundancy)
	}
	if len(got.MerkleProof) != 2 || got.MerkleProof[0] != "0xaa" {
		t.Fatalf("merkleProof not forwarded: %v", got.MerkleProof)
	}
	if got.ResultRef != "echo://0xout" {
		t.Fatalf("resultRef = %q", got.ResultRef)
	}
}

func TestProofServiceClient_RetriesOn5xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) < 3 {
			w.WriteHeader(http.StatusBadGateway) // 502 — retryable
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := NewProofServiceClient(srv.URL, nil)
	if err := c.Submit(context.Background(), ProofSubmission{Proof: sampleProof(), Redundancy: 1}); err != nil {
		t.Fatalf("submit should eventually succeed: %v", err)
	}
	if n := atomic.LoadInt32(&calls); n != 3 {
		t.Fatalf("expected 3 attempts (2 failures + success), got %d", n)
	}
}

func TestProofServiceClient_NoRetryOn4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusUnprocessableEntity) // 422 — terminal
		_, _ = w.Write([]byte(`{"error":"rejected"}`))
	}))
	defer srv.Close()

	c := NewProofServiceClient(srv.URL, nil)
	if err := c.Submit(context.Background(), ProofSubmission{Proof: sampleProof(), Redundancy: 1}); err == nil {
		t.Fatal("expected a 422 to surface as an error")
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("4xx must not be retried, got %d attempts", n)
	}
}

func TestProofServiceClient_RespectsContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway) // always retryable -> would loop
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	c := NewProofServiceClient(srv.URL, nil)
	if err := c.Submit(ctx, ProofSubmission{Proof: sampleProof(), Redundancy: 1}); err == nil {
		t.Fatal("expected cancelled context to abort submit")
	}
}
