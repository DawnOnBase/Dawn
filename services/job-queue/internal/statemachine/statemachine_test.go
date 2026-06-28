package statemachine

import (
	"testing"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

func TestCanTransition_HappyPath(t *testing.T) {
	path := []domain.JobStatus{
		domain.StatusSubmitted,
		domain.StatusEscrowed,
		domain.StatusMatched,
		domain.StatusRunning,
		domain.StatusProven,
		domain.StatusSettled,
	}
	for i := 0; i+1 < len(path); i++ {
		if !CanTransition(path[i], path[i+1]) {
			t.Errorf("expected %s → %s to be allowed", path[i], path[i+1])
		}
	}
}

func TestCanTransition_Requeue(t *testing.T) {
	// A dropped node requeues the job for re-matching.
	if !CanTransition(domain.StatusMatched, domain.StatusEscrowed) {
		t.Error("matched → escrowed (requeue) should be allowed")
	}
	if !CanTransition(domain.StatusRunning, domain.StatusEscrowed) {
		t.Error("running → escrowed (requeue) should be allowed")
	}
}

func TestCanTransition_Illegal(t *testing.T) {
	cases := [][2]domain.JobStatus{
		{domain.StatusSubmitted, domain.StatusRunning}, // skips escrow + match
		{domain.StatusEscrowed, domain.StatusProven},   // skips match + run
		{domain.StatusSettled, domain.StatusRunning},   // terminal
		{domain.StatusFailed, domain.StatusEscrowed},   // terminal
		{domain.StatusTimedOut, domain.StatusMatched},  // terminal
		{domain.StatusProven, domain.StatusMatched},    // backwards
		{domain.StatusRunning, domain.StatusSubmitted}, // backwards past escrow
	}
	for _, c := range cases {
		if CanTransition(c[0], c[1]) {
			t.Errorf("expected %s → %s to be illegal", c[0], c[1])
		}
	}
}

func TestTransition_ReturnsErrorAndValue(t *testing.T) {
	if _, err := Transition(domain.StatusSubmitted, domain.StatusSettled); err == nil {
		t.Error("expected error for illegal transition submitted → settled")
	}
	if _, err := Transition("bogus", domain.StatusEscrowed); err == nil {
		t.Error("expected error for unknown source status")
	}
	got, err := Transition(domain.StatusEscrowed, domain.StatusMatched)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != domain.StatusMatched {
		t.Fatalf("got %s, want %s", got, domain.StatusMatched)
	}
}

func TestIsTerminal(t *testing.T) {
	for _, s := range []domain.JobStatus{domain.StatusSettled, domain.StatusFailed, domain.StatusTimedOut} {
		if !IsTerminal(s) {
			t.Errorf("%s should be terminal", s)
		}
	}
	for _, s := range []domain.JobStatus{
		domain.StatusSubmitted, domain.StatusEscrowed, domain.StatusMatched,
		domain.StatusRunning, domain.StatusProven,
	} {
		if IsTerminal(s) {
			t.Errorf("%s should not be terminal", s)
		}
	}
}
