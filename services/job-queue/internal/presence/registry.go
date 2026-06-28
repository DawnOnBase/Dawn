// Package presence tracks which nodes are connected + authenticated right now, so the committee
// dispatcher can choose an M-of-N set from operators that can actually receive an assignment
// (M9 doc). The WebSocket layer (wsserver via coordinator) registers a node on `hello` and
// removes it on disconnect; the dispatcher reads a snapshot. Safe for concurrent use.
package presence

import (
	"sync"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// Registry is the live set of connected, authenticated node profiles keyed by NodeID.
type Registry struct {
	mu    sync.RWMutex
	nodes map[domain.Address]domain.NodeProfile
}

// NewRegistry builds an empty registry.
func NewRegistry() *Registry {
	return &Registry{nodes: make(map[domain.Address]domain.NodeProfile)}
}

// Add records (or refreshes) a connected node. A blank NodeID is ignored.
func (r *Registry) Add(p domain.NodeProfile) {
	if p.NodeID == "" {
		return
	}
	r.mu.Lock()
	r.nodes[p.NodeID] = p
	r.mu.Unlock()
}

// Remove drops a disconnected node. Safe to call for an unknown node.
func (r *Registry) Remove(nodeID domain.Address) {
	r.mu.Lock()
	delete(r.nodes, nodeID)
	r.mu.Unlock()
}

// Snapshot returns a copy of the currently-connected node profiles (order unspecified). The caller
// owns the slice; the registry may change immediately after.
func (r *Registry) Snapshot() []domain.NodeProfile {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]domain.NodeProfile, 0, len(r.nodes))
	for _, p := range r.nodes {
		out = append(out, p)
	}
	return out
}

// Len is the number of connected nodes (telemetry / readiness checks).
func (r *Registry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.nodes)
}
