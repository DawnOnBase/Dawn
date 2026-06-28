// Package matching is the job↔node matching engine : given a
// node pulling for work, decide which jobs it is eligible for and rank them.
//
// The network is pull-based (agent sends `pull_job`, the architecture), so the
// primary operation ranks eligible jobs from a single node's perspective.
// Ranking favors the operator (higher USDC first) then urgency (earlier
// deadline), gated by hardware capability. Spot price / reliability weighting
// from the pricing service plugs in via Weights.
package matching

import (
	"sort"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// Eligible reports whether a node meets a job's minimum hardware requirements.
func Eligible(node domain.NodeProfile, req domain.JobRequirements) bool {
	if req.MinCpuCores != nil && node.CpuCores < *req.MinCpuCores {
		return false
	}
	if req.MinRamGb != nil && node.RamGb < *req.MinRamGb {
		return false
	}
	if req.MinGpuTier != nil {
		if node.GpuTier == nil || *node.GpuTier < *req.MinGpuTier {
			return false
		}
	}
	if req.MinVramGb != nil {
		if node.VramGb == nil || *node.VramGb < *req.MinVramGb {
			return false
		}
	}
	return true
}

// Weights tunes job ranking. Zero value is a sensible default (pay-weighted).
type Weights struct {
	// PayWeight scales the USDC amount's contribution (default 1).
	PayWeight float64
	// UrgencyWeight scales how much an earlier deadline is preferred (default 1).
	UrgencyWeight float64
}

func (w Weights) withDefaults() Weights {
	if w.PayWeight == 0 {
		w.PayWeight = 1
	}
	if w.UrgencyWeight == 0 {
		w.UrgencyWeight = 1
	}
	return w
}

// RankJobsForNode returns the jobs the node is eligible for, best candidate
// first. `now` (unix seconds) is used to weigh urgency. Input is not mutated.
func RankJobsForNode(node domain.NodeProfile, jobs []domain.Job, now int64, w Weights) []domain.Job {
	w = w.withDefaults()

	eligible := make([]domain.Job, 0, len(jobs))
	for _, j := range jobs {
		if Eligible(node, j.Requirements) {
			eligible = append(eligible, j)
		}
	}

	sort.SliceStable(eligible, func(a, b int) bool {
		return scoreJob(eligible[a], now, w) > scoreJob(eligible[b], now, w)
	})
	return eligible
}

// BestJobForNode returns the single best eligible job, or nil if none.
func BestJobForNode(node domain.NodeProfile, jobs []domain.Job, now int64, w Weights) *domain.Job {
	ranked := RankJobsForNode(node, jobs, now, w)
	if len(ranked) == 0 {
		return nil
	}
	best := ranked[0]
	return &best
}

// scoreJob: higher pay raises the score; a nearer deadline raises it too.
// USDC is parsed from its base-unit string; unparseable amounts score as 0 pay.
func scoreJob(j domain.Job, now int64, w Weights) float64 {
	pay := parseUsdc(j.AmountUsdc)

	// Urgency: seconds until deadline, smaller (sooner) => higher score.
	// Map to a bounded positive term so far-future/past deadlines stay sane.
	secsLeft := float64(j.Deadline - now)
	urgency := 1.0 / (1.0 + maxF(secsLeft, 0)/3600.0) // ~1 when due now, →0 when far off

	return w.PayWeight*pay + w.UrgencyWeight*urgency
}

// parseUsdc reads USDC base units (6 decimals) from the decimal string into a
// float for ranking only (never for settlement math). Returns 0 on bad input.
func parseUsdc(s string) float64 {
	if s == "" {
		return 0
	}
	var n float64
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + float64(c-'0')
	}
	return n
}

func maxF(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
