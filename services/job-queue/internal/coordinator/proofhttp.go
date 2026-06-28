package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// ProofServiceClient is a ProofSink that forwards submitted proof bundles to the
// proof-service over HTTP. The proof-service runs redundancy consensus
// and drives on-chain settlement, so the coordinator stays oblivious to chain.
type ProofServiceClient struct {
	baseURL string
	http    *http.Client
	// retries is the number of additional attempts on transport / 5xx errors.
	retries int
}

// proofSubmitBody mirrors the proof-service POST /v1/proofs contract
// (services/proof-service/src/app.ts). resultRef is carried for traceability;
// the proof-service ignores unknown fields.
type proofSubmitBody struct {
	Proof       domain.ProofBundle `json:"proof"`
	Redundancy  int                `json:"redundancy"`
	ResultRef   string             `json:"resultRef,omitempty"`
	MerkleProof []domain.Hex       `json:"merkleProof,omitempty"` // committee membership proof (redundant only)
}

// NewProofServiceClient builds a ProofSink pointed at the proof-service base URL
// (e.g. http://proof-service:8091). A nil httpClient uses a 10s-timeout default.
func NewProofServiceClient(baseURL string, httpClient *http.Client) *ProofServiceClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &ProofServiceClient{baseURL: baseURL, http: httpClient, retries: 2}
}

func (c *ProofServiceClient) Submit(ctx context.Context, sub ProofSubmission) error {
	redundancy := sub.Redundancy
	if redundancy < 1 {
		redundancy = 1
	}
	payload, err := json.Marshal(proofSubmitBody{
		Proof: sub.Proof, Redundancy: redundancy, ResultRef: sub.ResultRef, MerkleProof: sub.MerkleProof,
	})
	if err != nil {
		return fmt.Errorf("proof client: marshal: %w", err)
	}
	url := c.baseURL + "/v1/proofs"

	var lastErr error
	for attempt := 0; attempt <= c.retries; attempt++ {
		if attempt > 0 {
			// Linear backoff, cancellable.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 200 * time.Millisecond):
			}
		}
		retry, err := c.post(ctx, url, payload)
		if err == nil {
			return nil
		}
		lastErr = err
		if !retry {
			return err // 4xx etc. — retrying won't help.
		}
	}
	return fmt.Errorf("proof client: giving up after %d attempts: %w", c.retries+1, lastErr)
}

// post sends one request. The bool reports whether the error is worth retrying
// (transport failure or 5xx); 4xx responses are terminal.
func (c *ProofServiceClient) post(ctx context.Context, url string, payload []byte) (retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return false, fmt.Errorf("proof client: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return true, fmt.Errorf("proof client: post: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return false, nil
	case resp.StatusCode >= 500:
		return true, fmt.Errorf("proof client: proof-service %d: %s", resp.StatusCode, body)
	default:
		return false, fmt.Errorf("proof client: proof-service rejected %d: %s", resp.StatusCode, body)
	}
}
