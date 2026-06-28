package dispatch

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// assignRequest is the POST /v1/assignments body: the caller (the API / a relayer) asks the
// orchestrator to seat + sign a committee for an already-submitted redundant job, then uses the
// returned authorization to call escrowRedundant on-chain.
type assignRequest struct {
	JobID     domain.Hex `json:"jobId"`
	InputHash domain.Hex `json:"inputHash"` // keccak256(canonical Job Package), orchestrator-pinned
	Bond      string     `json:"bond"`      // per-job operator bond, USDC base units
}

type assignResponse struct {
	JobID           domain.Hex       `json:"jobId"`
	Operators       []domain.Address `json:"operators"`
	OperatorSetRoot domain.Hex       `json:"operatorSetRoot"`
	AssignmentSig   domain.Hex       `json:"assignmentSig"`
	InputHash       domain.Hex       `json:"inputHash"`
	Nonce           uint64           `json:"nonce"`
	Bond            string           `json:"bond"`
	Amount          string           `json:"amount"`
	Deadline        int64            `json:"deadline"`
	Redundancy      int              `json:"redundancy"`
}

// Handler serves POST /v1/assignments. Mount it alongside the agent WebSocket. The on-chain
// escrowRedundant call that consumes this response is the [S] settlement seam, not done here.
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/assignments", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req assignRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if req.JobID == "" || req.InputHash == "" || req.Bond == "" {
			http.Error(w, "jobId, inputHash and bond are required", http.StatusBadRequest)
			return
		}
		res, err := s.PrepareAndSign(r.Context(), req.JobID, req.InputHash, req.Bond)
		if err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, ErrInsufficientNodes) {
				code = http.StatusServiceUnavailable // retry when more operators connect
			}
			http.Error(w, err.Error(), code)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(assignResponse{
			JobID:           req.JobID,
			Operators:       res.Operators,
			OperatorSetRoot: res.OperatorSetRoot,
			AssignmentSig:   res.AssignmentSig,
			InputHash:       res.InputHash,
			Nonce:           res.Nonce,
			Bond:            res.Bond,
			Amount:          res.Amount,
			Deadline:        res.Deadline,
			Redundancy:      res.Redundancy,
		})
	})
	return mux
}
