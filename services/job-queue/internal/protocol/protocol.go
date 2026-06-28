// Package protocol mirrors the shared Agent↔Backend protocol in
// packages/shared/src/protocol.ts . Transport: WebSocket, JSON
// messages, node-wallet-signature auth on `hello`. TypeScript is the source of
// truth — keep the `t` tags and field names identical; do not change shapes
// without both owners' sign-off.
package protocol

import (
	"encoding/json"
	"fmt"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// AgentMsgType / BackendMsgType are the `t` discriminators.
type (
	AgentMsgType   string
	BackendMsgType string
)

const (
	MsgHello        AgentMsgType = "hello"
	MsgPullJob      AgentMsgType = "pull_job"
	MsgHeartbeat    AgentMsgType = "heartbeat"
	MsgSubmitResult AgentMsgType = "submit_result"

	MsgJobAssignment BackendMsgType = "job_assignment"
	MsgNoJob         BackendMsgType = "no_job"
	MsgAck           BackendMsgType = "ack"
	MsgPause         BackendMsgType = "pause"
	MsgResume        BackendMsgType = "resume"
)

// AgentToBackend is the decoded union of inbound messages. Exactly one payload
// field is set, selected by T.
type AgentToBackend struct {
	T AgentMsgType `json:"t"`

	// hello
	NodeID  domain.Address      `json:"nodeId,omitempty"`
	Sig     domain.Hex          `json:"sig,omitempty"`
	Profile *domain.NodeProfile `json:"profile,omitempty"`

	// heartbeat
	Ts int64 `json:"ts,omitempty"`

	// submit_result
	Proof     *domain.ProofBundle `json:"proof,omitempty"`
	ResultRef string              `json:"resultRef,omitempty"`
}

// BackendToAgent is an outbound message. Use the constructors below.
type BackendToAgent struct {
	T BackendMsgType `json:"t"`

	// job_assignment
	JobID    domain.Hex `json:"jobId,omitempty"`
	InputRef string     `json:"inputRef,omitempty"`
	Deadline int64      `json:"deadline,omitempty"`

	// job_assignment — M9 redundant fields (additive; present only for a redundant assignment, so
	// the single-node job_assignment wire shape is unchanged). The agent submits its proof with the
	// MerkleProof against OperatorSetRoot; AssignmentSig is the orchestrator authorization the
	// contract verifies. See packages/shared/src/protocol.ts  + M9 doc
	OperatorSetRoot domain.Hex   `json:"operatorSetRoot,omitempty"`
	AssignmentSig   domain.Hex   `json:"assignmentSig,omitempty"`
	MerkleProof     []domain.Hex `json:"merkleProof,omitempty"`
	Redundancy      int          `json:"redundancy,omitempty"`
	Nonce           uint64       `json:"nonce,omitempty"`
	Bond            string       `json:"bond,omitempty"`
}

func JobAssignment(jobID domain.Hex, inputRef string, deadline int64) BackendToAgent {
	return BackendToAgent{T: MsgJobAssignment, JobID: jobID, InputRef: inputRef, Deadline: deadline}
}

// RedundantJobAssignment is the job_assignment for an M-of-N committee member: it carries the
// single-node fields plus the orchestrator authorization (operatorSetRoot + assignmentSig), the
// member's own merkleProof, and the redundancy/nonce/bond the agent needs to stake + submit.
func RedundantJobAssignment(
	jobID domain.Hex, inputRef string, deadline int64,
	operatorSetRoot, assignmentSig domain.Hex, merkleProof []domain.Hex,
	redundancy int, nonce uint64, bond string,
) BackendToAgent {
	return BackendToAgent{
		T: MsgJobAssignment, JobID: jobID, InputRef: inputRef, Deadline: deadline,
		OperatorSetRoot: operatorSetRoot, AssignmentSig: assignmentSig, MerkleProof: merkleProof,
		Redundancy: redundancy, Nonce: nonce, Bond: bond,
	}
}
func NoJob() BackendToAgent               { return BackendToAgent{T: MsgNoJob} }
func Ack(jobID domain.Hex) BackendToAgent { return BackendToAgent{T: MsgAck, JobID: jobID} }
func Pause() BackendToAgent               { return BackendToAgent{T: MsgPause} }
func Resume() BackendToAgent              { return BackendToAgent{T: MsgResume} }

// DecodeAgentMessage parses a raw JSON frame into an AgentToBackend, validating
// the `t` tag.
func DecodeAgentMessage(raw []byte) (AgentToBackend, error) {
	var m AgentToBackend
	if err := json.Unmarshal(raw, &m); err != nil {
		return AgentToBackend{}, fmt.Errorf("protocol: bad json: %w", err)
	}
	switch m.T {
	case MsgHello, MsgPullJob, MsgHeartbeat, MsgSubmitResult:
		return m, nil
	default:
		return AgentToBackend{}, fmt.Errorf("protocol: unknown message type %q", m.T)
	}
}

// Encode serializes an outbound message.
func (b BackendToAgent) Encode() ([]byte, error) { return json.Marshal(b) }
