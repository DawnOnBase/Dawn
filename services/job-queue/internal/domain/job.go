// Package domain mirrors the shared shared types in
// packages/shared/src/types.ts . TypeScript remains the single
// source of truth — keep these shapes and JSON tags in sync with it, and do not
// diverge the seam without both owners' sign-off (the Dawn team).
package domain

// Address and Hex are 0x-prefixed hex strings (mirror of the TS branded types).
type (
	Address = string
	Hex     = string
)

// JobStatus is the lifecycle of a job across the backend + chain.
type JobStatus string

const (
	StatusSubmitted JobStatus = "submitted"
	StatusEscrowed  JobStatus = "escrowed"
	StatusMatched   JobStatus = "matched"
	StatusRunning   JobStatus = "running"
	StatusProven    JobStatus = "proven"
	StatusSettled   JobStatus = "settled"
	StatusFailed    JobStatus = "failed"
	StatusTimedOut  JobStatus = "timed_out"
)

// JobType mirrors the shared JobType union.
type JobType string

const (
	JobInference      JobType = "inference"
	JobDataProcessing JobType = "data_processing"
	JobRendering      JobType = "rendering"
	JobFineTuneShard  JobType = "fine_tune_shard"
	JobGeneralCompute JobType = "general_compute"
)

// NodeProfile is an anonymized hardware profile — never the exact device model
// (privacy, the architecture). The node wallet address is the only identity.
type NodeProfile struct {
	NodeID           Address `json:"nodeId"`
	GpuTier          *int    `json:"gpuTier"` // coarse tier 1..5; null/nil = CPU-only
	VramGb           *int    `json:"vramGb"`
	CpuCores         int     `json:"cpuCores"`
	RamGb            int     `json:"ramGb"`
	Region           string  `json:"region"`           // coarse geo, e.g. "us-east"
	ReliabilityScore float64 `json:"reliabilityScore"` // 0..1
}

// JobRequirements mirrors the shared JobRequirements.
type JobRequirements struct {
	JobType              JobType `json:"jobType"`
	MinGpuTier           *int    `json:"minGpuTier,omitempty"`
	MinVramGb            *int    `json:"minVramGb,omitempty"`
	MinCpuCores          *int    `json:"minCpuCores,omitempty"`
	MinRamGb             *int    `json:"minRamGb,omitempty"`
	EstimatedDurationSec int     `json:"estimatedDurationSec"`
	// Redundancy >1 => redundant execution + consensus .
	Redundancy *int `json:"redundancy,omitempty"`
}

// Job mirrors the shared Job. AmountUsdc is USDC base units (6 decimals) kept as
// a string to avoid float precision loss, identical to the TS contract.
type Job struct {
	JobID        Hex             `json:"jobId"` // keccak256; same value as Settlement contract jobId
	Buyer        Address         `json:"buyer"`
	Requirements JobRequirements `json:"requirements"`
	AmountUsdc   string          `json:"amountUsdc"`
	Deadline     int64           `json:"deadline"` // unix seconds
	Status       JobStatus       `json:"status"`
	Operator     *Address        `json:"operator,omitempty"` // assigned node, once matched (single-node)

	// --- M9 redundant-execution fields (the redundant-execution design).
	// All zero/absent for single-node jobs, so the single-node JSON wire shape is
	// byte-for-byte unchanged. For a redundant job these carry the orchestrator-
	// signed committee Assignment the contract verifies at escrowRedundant. ---
	InputHash       Hex       `json:"inputHash,omitempty"`       // keccak256(canonical Job Package); orchestrator-pinned
	Operators       []Address `json:"operators,omitempty"`       // the M authorized committee, in assignment (Merkle) order
	OperatorSetRoot Hex       `json:"operatorSetRoot,omitempty"` // sorted-pair Merkle root over Operators
	AssignmentSig   Hex       `json:"assignmentSig,omitempty"`   // orchestrator EIP-712 signature authorizing the committee
	Nonce           uint64    `json:"nonce,omitempty"`           // monotonic per jobId from the backend (replay-safe; nonce+1 on re-run)
	Bond            string    `json:"bond,omitempty"`            // per-job operator bond, USDC base units (string, like AmountUsdc)
}

// IsRedundant reports whether the job runs the M-of-N redundant consensus flow
// (Requirements.Redundancy >= 2), as opposed to the single-node escrow→settle path.
func (j Job) IsRedundant() bool {
	return j.Requirements.Redundancy != nil && *j.Requirements.Redundancy >= 2
}

// CommitteeIndex returns the assignment-order index of nodeID in the authorized
// committee, or -1 if it is not a member. The index is what the Merkle proof is
// built against, so it MUST match the order Operators was committed in.
func (j Job) CommitteeIndex(nodeID Address) int {
	for i, op := range j.Operators {
		if op == nodeID {
			return i
		}
	}
	return -1
}

// InCommittee reports whether nodeID is one of the job's authorized operators.
func (j Job) InCommittee(nodeID Address) bool { return j.CommitteeIndex(nodeID) >= 0 }

// ProofBundle mirrors the shared ProofBundle (ISettlement.ProofBundle).
type ProofBundle struct {
	JobID         Hex `json:"jobId"`
	InputHash     Hex `json:"inputHash"`
	OutputHash    Hex `json:"outputHash"`
	Metadata      Hex `json:"metadata"`
	NodeSignature Hex `json:"nodeSignature"`
}
