// Package coordinator turns decoded agent protocol messages into queue
// operations . It is transport-agnostic: the WebSocket server
// (internal/wsserver) feeds it decoded messages and writes back its replies, so
// the logic here is unit-tested without a network.
package coordinator

import (
	"context"
	"errors"
	"fmt"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/orchestrator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/presence"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/protocol"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
)

// Authenticator verifies a node's `hello` signature .
type Authenticator interface {
	Verify(nodeID domain.Address, sig domain.Hex) error
}

// InputResolver returns the off-chain input reference for a job. This is
// backend-internal metadata (a DB column), deliberately NOT part of the shared
// domain.Job wire type.
type InputResolver interface {
	InputRef(ctx context.Context, jobID domain.Hex) (string, error)
}

// ProofSubmission is what the coordinator hands to the proof-service for one node's result.
type ProofSubmission struct {
	Proof      domain.ProofBundle
	ResultRef  string
	Redundancy int // job M (1 for single-node) — selects server-settle vs. agent self-settle (M0 D3)
	// MerkleProof is the operator's committee-membership proof (redundant only; empty for single-node).
	// The proof-service needs it to drive the on-chain redundant submitProof(proof, operator, merkleProof).
	MerkleProof []domain.Hex
}

// ProofSink hands a submitted proof to off-chain validation (proof-service,), which
// orchestrates redundancy + on-chain settlement.
type ProofSink interface {
	Submit(ctx context.Context, sub ProofSubmission) error
}

// Session is per-connection agent state held by the transport layer.
type Session struct {
	NodeID        domain.Address
	Profile       domain.NodeProfile
	Authenticated bool
	LastSeen      int64
	CurrentJob    domain.Hex // job currently assigned to this node, if any
}

// Coordinator is safe for concurrent use as long as the Queue is.
type Coordinator struct {
	q        queue.Queue
	auth     Authenticator
	inputs   InputResolver
	proofs   ProofSink
	now      queue.Clock
	presence *presence.Registry // optional; populated for committee dispatch
}

func New(q queue.Queue, auth Authenticator, inputs InputResolver, proofs ProofSink, now queue.Clock) *Coordinator {
	if now == nil {
		now = func() int64 { return 0 }
	}
	return &Coordinator{q: q, auth: auth, inputs: inputs, proofs: proofs, now: now}
}

// WithPresence wires a node-presence registry so connected operators are tracked for the committee
// dispatcher (M9). Optional — when nil the coordinator behaves exactly as before.
func (c *Coordinator) WithPresence(r *presence.Registry) *Coordinator {
	c.presence = r
	return c
}

// ErrUnauthenticated is returned for non-hello messages before a valid hello.
var ErrUnauthenticated = errors.New("coordinator: node not authenticated")

// Handle processes one agent message and returns the reply to send back, or nil
// if the message has no reply (hello, heartbeat). It mutates the session.
func (c *Coordinator) Handle(ctx context.Context, s *Session, msg protocol.AgentToBackend) (*protocol.BackendToAgent, error) {
	switch msg.T {
	case protocol.MsgHello:
		return nil, c.handleHello(s, msg)
	case protocol.MsgPullJob:
		return c.handlePull(ctx, s)
	case protocol.MsgHeartbeat:
		return nil, c.handleHeartbeat(ctx, s, msg)
	case protocol.MsgSubmitResult:
		return c.handleSubmit(ctx, s, msg)
	default:
		return nil, fmt.Errorf("coordinator: unhandled message %q", msg.T)
	}
}

// Disconnect releases a dropped node's in-flight job back to the queue so another
// node can pick it up immediately, instead of stranding it (and the buyer's escrow)
// until the deadline. Called by the transport when a connection closes. Best-effort:
// errors are swallowed since the node is already gone.
func (c *Coordinator) Disconnect(ctx context.Context, s *Session) {
	if c.presence != nil && s.NodeID != "" {
		c.presence.Remove(s.NodeID)
	}
	jobID := s.CurrentJob
	s.CurrentJob = ""
	if jobID == "" {
		return // no job in flight (idle, or already submitted)
	}
	job, err := c.q.Get(ctx, jobID)
	if err != nil {
		return
	}
	// Only requeue if it's still ours and still in flight (not proven/settled/terminal).
	if job.Operator == nil || *job.Operator != s.NodeID {
		return
	}
	if job.Status == domain.StatusMatched || job.Status == domain.StatusRunning {
		_ = c.q.Requeue(ctx, jobID)
	}
}

func (c *Coordinator) handleHello(s *Session, msg protocol.AgentToBackend) error {
	if msg.Profile == nil {
		return errors.New("coordinator: hello missing profile")
	}
	if err := c.auth.Verify(msg.NodeID, msg.Sig); err != nil {
		return fmt.Errorf("coordinator: hello auth failed: %w", err)
	}
	s.NodeID = msg.NodeID
	s.Profile = *msg.Profile
	s.Authenticated = true
	s.LastSeen = c.now()
	if c.presence != nil {
		c.presence.Add(s.Profile)
	}
	return nil
}

func (c *Coordinator) handlePull(ctx context.Context, s *Session) (*protocol.BackendToAgent, error) {
	if !s.Authenticated {
		return nil, ErrUnauthenticated
	}
	// Redundant committees are PRE-assigned (M9 doc #4): a member discovers itself already
	// authorized rather than racing for a slot, so prefer an assignment this node belongs to before
	// claiming a single-node job.
	job, err := c.q.FindCommitteeJob(ctx, s.NodeID)
	if err == nil {
		return c.assignRedundant(ctx, s, job)
	}
	if !errors.Is(err, queue.ErrNoJob) {
		return nil, err
	}

	// Single-node path (unchanged): atomically claim the best eligible escrowed job.
	job, err = c.q.Claim(ctx, s.Profile)
	if errors.Is(err, queue.ErrNoJob) {
		reply := protocol.NoJob()
		return &reply, nil
	}
	if err != nil {
		return nil, err
	}
	inputRef, err := c.inputs.InputRef(ctx, job.JobID)
	if err != nil {
		// Roll the claim back so the job can be matched again, then report.
		_ = c.q.Requeue(ctx, job.JobID)
		return nil, fmt.Errorf("coordinator: resolve input for %s: %w", job.JobID, err)
	}
	s.CurrentJob = job.JobID
	reply := protocol.JobAssignment(job.JobID, inputRef, job.Deadline)
	return &reply, nil
}

// assignRedundant builds the job_assignment for a committee member: its own Merkle inclusion proof
// against the committed operatorSetRoot, plus the orchestrator AssignmentSig the contract verifies.
// It does NOT mutate the job (membership is fixed at assignment, so all M members pull the same job).
func (c *Coordinator) assignRedundant(ctx context.Context, s *Session, job domain.Job) (*protocol.BackendToAgent, error) {
	idx := job.CommitteeIndex(s.NodeID)
	if idx < 0 {
		// FindCommitteeJob already filtered on membership; defensive only.
		return nil, fmt.Errorf("coordinator: node %s not in committee for job %s", s.NodeID, job.JobID)
	}
	merkleProof, err := orchestrator.MerkleProof(job.Operators, idx)
	if err != nil {
		return nil, fmt.Errorf("coordinator: merkle proof for %s: %w", job.JobID, err)
	}
	inputRef, err := c.inputs.InputRef(ctx, job.JobID)
	if err != nil {
		// Unlike single-node we do NOT requeue — the committee is shared and fixed; one member's
		// input-resolution failure must not yank the job from the others.
		return nil, fmt.Errorf("coordinator: resolve input for %s: %w", job.JobID, err)
	}
	s.CurrentJob = job.JobID
	m := 0
	if job.Requirements.Redundancy != nil {
		m = *job.Requirements.Redundancy
	}
	reply := protocol.RedundantJobAssignment(
		job.JobID, inputRef, job.Deadline,
		job.OperatorSetRoot, job.AssignmentSig, merkleProof, m, job.Nonce, job.Bond)
	return &reply, nil
}

func (c *Coordinator) handleHeartbeat(ctx context.Context, s *Session, msg protocol.AgentToBackend) error {
	if !s.Authenticated {
		return ErrUnauthenticated
	}
	s.LastSeen = msg.Ts
	// First heartbeat after assignment marks the job as actually running.
	if s.CurrentJob != "" {
		if j, err := c.q.Get(ctx, s.CurrentJob); err == nil && j.Status == domain.StatusMatched {
			_, _ = c.q.Transition(ctx, s.CurrentJob, domain.StatusRunning)
		}
	}
	return nil
}

func (c *Coordinator) handleSubmit(ctx context.Context, s *Session, msg protocol.AgentToBackend) (*protocol.BackendToAgent, error) {
	if !s.Authenticated {
		return nil, ErrUnauthenticated
	}
	if msg.Proof == nil {
		return nil, errors.New("coordinator: submit_result missing proof")
	}
	jobID := msg.Proof.JobID
	job, err := c.q.Get(ctx, jobID)
	if err != nil {
		return nil, err
	}
	if job.IsRedundant() {
		return c.handleRedundantSubmit(ctx, s, job, msg)
	}

	if job.Operator == nil || *job.Operator != s.NodeID {
		return nil, fmt.Errorf("coordinator: node %s may not submit for job %s", s.NodeID, jobID)
	}
	// Persist the result first (idempotent) so the buyer's GET /result returns real
	// data, and so a retry after a later failure re-records cleanly before Proven.
	if err := c.q.RecordResult(ctx, jobID, msg.ResultRef, msg.Proof.OutputHash); err != nil {
		return nil, fmt.Errorf("coordinator: record result: %w", err)
	}
	// Advance to Proven (stepping through Running if the job was still Matched).
	if job.Status == domain.StatusMatched {
		if _, err := c.q.Transition(ctx, jobID, domain.StatusRunning); err != nil {
			return nil, err
		}
	}
	if _, err := c.q.Transition(ctx, jobID, domain.StatusProven); err != nil {
		return nil, err
	}
	// Hand the proof to off-chain validation + settlement ( →). Single-node: redundancy=1,
	// so the proof-service verifies + records and the AGENT self-settles on-chain (M0 D3).
	if err := c.proofs.Submit(ctx, ProofSubmission{Proof: *msg.Proof, ResultRef: msg.ResultRef, Redundancy: 1}); err != nil {
		return nil, fmt.Errorf("coordinator: proof sink: %w", err)
	}
	s.CurrentJob = ""
	reply := protocol.Ack(jobID)
	return &reply, nil
}

// handleRedundantSubmit accepts one committee member's proof for an M-of-N job. It enforces
// membership + one-slot-per-operator, forwards every member's proof to the proof-service (the
// redundant settler-of-record, M0 D3) with the real M so it can run super-plurality consensus, and
// flips the job to Proven once a super-plurality has submitted. The authoritative consensus + the
// on-chain settle/claim happen in the proof-service; this is the queue-side bookkeeping.
func (c *Coordinator) handleRedundantSubmit(
	ctx context.Context, s *Session, job domain.Job, msg protocol.AgentToBackend,
) (*protocol.BackendToAgent, error) {
	if !job.InCommittee(s.NodeID) {
		return nil, fmt.Errorf("coordinator: node %s not in committee for job %s", s.NodeID, job.JobID)
	}
	// One slot per operator (mirrors the contract's submissions[jobId][operator].submitted): a
	// double-submit is rejected, so a single node cannot inflate the quorum count.
	count, err := c.q.RecordCommitteeSubmission(ctx, job.JobID, s.NodeID)
	if err != nil {
		return nil, fmt.Errorf("coordinator: record committee submission: %w", err)
	}
	// Record this member's result. Honest members converge on the same outputHash (D1 determinism),
	// so last-write-wins still leaves the buyer's GET /result with the agreed output.
	if err := c.q.RecordResult(ctx, job.JobID, msg.ResultRef, msg.Proof.OutputHash); err != nil {
		return nil, fmt.Errorf("coordinator: record result: %w", err)
	}
	m := *job.Requirements.Redundancy
	// Recompute this operator's membership proof so the proof-service (the redundant settler-of-
	// record) can drive the on-chain submitProof(proof, operator, merkleProof).
	var merkleProof []domain.Hex
	if idx := job.CommitteeIndex(s.NodeID); idx >= 0 {
		if mp, err := orchestrator.MerkleProof(job.Operators, idx); err == nil {
			merkleProof = mp
		}
	}
	if err := c.proofs.Submit(ctx, ProofSubmission{
		Proof: *msg.Proof, ResultRef: msg.ResultRef, Redundancy: m, MerkleProof: merkleProof,
	}); err != nil {
		return nil, fmt.Errorf("coordinator: proof sink: %w", err)
	}
	// Once a super-plurality has submitted, the job is provable. Best-effort status bookkeeping —
	// the contract/proof-service are authoritative — so transition errors (e.g. another member's
	// submit already advanced it) are swallowed.
	if count >= quorum(m) {
		if job.Status == domain.StatusMatched {
			_, _ = c.q.Transition(ctx, job.JobID, domain.StatusRunning)
		}
		_, _ = c.q.Transition(ctx, job.JobID, domain.StatusProven)
	}
	s.CurrentJob = ""
	reply := protocol.Ack(job.JobID)
	return &reply, nil
}

// quorum is the super-plurality threshold ceil(m * 2/3), byte-identical to Settlement._quorum
// ((2*m + 2)/3). For 2→2, 3→2, 4→3, 5→4. Used only for queue-side status bookkeeping; the contract
// is the authority on when consensus actually freezes.
func quorum(m int) int {
	if m < 2 {
		return 1
	}
	return (2*m + 2) / 3
}
