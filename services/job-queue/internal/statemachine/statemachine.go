// Package statemachine encodes the job lifecycle transitions :
//
//	submitted → escrowed → matched → running → proven → settled
//
// with failure, timeout, and requeue branches. The JobStatus values are the
// shared enum from packages/shared (mirrored in domain.JobStatus); the set of
// legal transitions below is backend-internal policy owned by the backend.
package statemachine

import (
	"fmt"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// allowed maps each status to the set of statuses it may transition to.
// A status that maps to an empty set is terminal.
var allowed = map[domain.JobStatus]map[domain.JobStatus]bool{
	domain.StatusSubmitted: set(domain.StatusEscrowed, domain.StatusFailed, domain.StatusTimedOut),
	domain.StatusEscrowed:  set(domain.StatusMatched, domain.StatusTimedOut, domain.StatusFailed),
	// matched/running may requeue back to escrowed if the assigned node drops.
	domain.StatusMatched:  set(domain.StatusRunning, domain.StatusEscrowed, domain.StatusTimedOut, domain.StatusFailed),
	domain.StatusRunning:  set(domain.StatusProven, domain.StatusEscrowed, domain.StatusFailed, domain.StatusTimedOut),
	domain.StatusProven:   set(domain.StatusSettled, domain.StatusFailed),
	domain.StatusSettled:  set(),
	domain.StatusFailed:   set(),
	domain.StatusTimedOut: set(),
}

func set(statuses ...domain.JobStatus) map[domain.JobStatus]bool {
	m := make(map[domain.JobStatus]bool, len(statuses))
	for _, s := range statuses {
		m[s] = true
	}
	return m
}

// Known reports whether s is a recognized job status.
func Known(s domain.JobStatus) bool {
	_, ok := allowed[s]
	return ok
}

// IsTerminal reports whether a status has no outgoing transitions.
func IsTerminal(s domain.JobStatus) bool {
	next, ok := allowed[s]
	return ok && len(next) == 0
}

// CanTransition reports whether from → to is a permitted transition.
func CanTransition(from, to domain.JobStatus) bool {
	next, ok := allowed[from]
	if !ok {
		return false
	}
	return next[to]
}

// Transition validates from → to and returns the next status, or an error if
// the transition is not permitted. Callers persist the result atomically
// (e.g. a conditional UPDATE guarded by the current status).
func Transition(from, to domain.JobStatus) (domain.JobStatus, error) {
	if !Known(from) {
		return from, fmt.Errorf("unknown job status %q", from)
	}
	if !Known(to) {
		return from, fmt.Errorf("unknown target status %q", to)
	}
	if !CanTransition(from, to) {
		return from, fmt.Errorf("illegal job transition %s → %s", from, to)
	}
	return to, nil
}
