package wsserver

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/coordinator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/protocol"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
)

func intp(i int) *int { return &i }

// End-to-end transport test: a real WebSocket client drives hello → pull →
// submit against the coordinator over an httptest server. No external infra.
func TestAgentRoundTrip(t *testing.T) {
	now := func() int64 { return 1000 }
	q := queue.NewMemory(now, matching.Weights{})
	inputs := coordinator.NewMapInputResolver()
	_ = q.Enqueue(context.Background(), domain.Job{
		JobID: "j1", Buyer: "0xbuyer", AmountUsdc: "5000000", Deadline: 9000, Status: domain.StatusEscrowed,
		Requirements: domain.JobRequirements{JobType: domain.JobGeneralCompute, MinCpuCores: intp(2), EstimatedDurationSec: 60},
	})
	inputs.Set("j1", "ipfs://input/j1")
	// Channel (not a shared slice) so the server goroutine handing off the proof
	// synchronizes cleanly with the test goroutine under -race.
	sunkCh := make(chan domain.ProofBundle, 4)
	sink := coordinator.ProofSinkFunc(func(_ context.Context, s coordinator.ProofSubmission) error {
		sunkCh <- s.Proof
		return nil
	})
	coord := coordinator.New(q, coordinator.AllowAllAuth{}, inputs, sink, now)

	srv := httptest.NewServer(New(coord).Handler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/agent"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	send := func(m protocol.AgentToBackend) {
		b, _ := json.Marshal(m)
		if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	recv := func() protocol.BackendToAgent {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var m protocol.BackendToAgent
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return m
	}

	prof := domain.NodeProfile{NodeID: "0xnode", CpuCores: 8, RamGb: 32, ReliabilityScore: 0.9}
	send(protocol.AgentToBackend{T: protocol.MsgHello, NodeID: "0xnode", Sig: "0xsig", Profile: &prof})
	send(protocol.AgentToBackend{T: protocol.MsgPullJob})

	assign := recv()
	if assign.T != protocol.MsgJobAssignment || assign.JobID != "j1" || assign.InputRef != "ipfs://input/j1" {
		t.Fatalf("bad assignment: %+v", assign)
	}

	send(protocol.AgentToBackend{T: protocol.MsgSubmitResult,
		Proof:     &domain.ProofBundle{JobID: "j1", OutputHash: "0xout"},
		ResultRef: "ipfs://out/j1"})
	ack := recv()
	if ack.T != protocol.MsgAck || ack.JobID != "j1" {
		t.Fatalf("expected ack, got %+v", ack)
	}

	if j, _ := q.Get(ctx, "j1"); j.Status != domain.StatusProven {
		t.Fatalf("job should be proven, got %s", j.Status)
	}
	select {
	case p := <-sunkCh:
		if p.JobID != "j1" {
			t.Fatalf("expected proof for j1, got %s", p.JobID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected proof handed to sink")
	}

	conn.Close(websocket.StatusNormalClosure, "done")
}
