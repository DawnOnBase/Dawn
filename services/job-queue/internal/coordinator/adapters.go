package coordinator

import (
	"context"
	"errors"
	"sync"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// AllowAllAuth accepts any non-empty nodeId WITHOUT verifying the signature.
// It exists for local dev/tests only. TODO: replace with real
// node-wallet signature verification (EIP-191 secp256k1 recover == nodeId)
// before any untrusted node connects — tracked as the auth follow-up.
type AllowAllAuth struct{}

func (AllowAllAuth) Verify(nodeID domain.Address, _ domain.Hex) error {
	if nodeID == "" {
		return errors.New("auth: empty nodeId")
	}
	return nil
}

// MapInputResolver is an in-memory InputResolver for dev/tests. In production
// the input ref is a column on the jobs row, resolved from Postgres.
type MapInputResolver struct {
	mu  sync.RWMutex
	ref map[domain.Hex]string
}

func NewMapInputResolver() *MapInputResolver { return &MapInputResolver{ref: map[domain.Hex]string{}} }

func (r *MapInputResolver) Set(jobID domain.Hex, ref string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ref[jobID] = ref
}

func (r *MapInputResolver) InputRef(_ context.Context, jobID domain.Hex) (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ref, ok := r.ref[jobID]
	if !ok {
		return "", errors.New("input resolver: no input ref for job")
	}
	return ref, nil
}

// ProofSinkFunc adapts a function to the ProofSink interface.
type ProofSinkFunc func(ctx context.Context, sub ProofSubmission) error

func (f ProofSinkFunc) Submit(ctx context.Context, sub ProofSubmission) error {
	return f(ctx, sub)
}
