package matching

import (
	"testing"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

func intp(i int) *int { return &i }

func gpuNode() domain.NodeProfile {
	return domain.NodeProfile{
		NodeID: "0xnode", GpuTier: intp(3), VramGb: intp(16),
		CpuCores: 8, RamGb: 32, Region: "us-east", ReliabilityScore: 0.9,
	}
}

func cpuNode() domain.NodeProfile {
	return domain.NodeProfile{NodeID: "0xcpu", CpuCores: 4, RamGb: 8, Region: "eu-west", ReliabilityScore: 0.7}
}

func job(id, amount string, req domain.JobRequirements, deadline int64) domain.Job {
	return domain.Job{JobID: id, AmountUsdc: amount, Requirements: req, Deadline: deadline, Status: domain.StatusEscrowed}
}

func TestEligible(t *testing.T) {
	gpuReq := domain.JobRequirements{JobType: domain.JobInference, MinGpuTier: intp(2), MinVramGb: intp(8), EstimatedDurationSec: 60}
	if !Eligible(gpuNode(), gpuReq) {
		t.Error("gpu node should satisfy gpu job")
	}
	if Eligible(cpuNode(), gpuReq) {
		t.Error("cpu-only node should NOT satisfy gpu job")
	}

	bigRam := domain.JobRequirements{JobType: domain.JobGeneralCompute, MinRamGb: intp(64), EstimatedDurationSec: 60}
	if Eligible(gpuNode(), bigRam) {
		t.Error("node with 32GB should fail 64GB requirement")
	}
}

func TestRankJobsForNode_FiltersAndRanksByPay(t *testing.T) {
	now := int64(1000)
	cpuReq := domain.JobRequirements{JobType: domain.JobGeneralCompute, MinCpuCores: intp(2), EstimatedDurationSec: 60}
	gpuReq := domain.JobRequirements{JobType: domain.JobInference, MinGpuTier: intp(4), EstimatedDurationSec: 60}

	jobs := []domain.Job{
		job("low", "1000000", cpuReq, now+7200),  // 1 USDC, eligible
		job("high", "5000000", cpuReq, now+7200), // 5 USDC, eligible
		job("gpu", "9000000", gpuReq, now+7200),  // 9 USDC but needs tier4 -> ineligible for cpuNode
	}

	ranked := RankJobsForNode(cpuNode(), jobs, now, Weights{})
	if len(ranked) != 2 {
		t.Fatalf("expected 2 eligible jobs, got %d", len(ranked))
	}
	if ranked[0].JobID != "high" {
		t.Errorf("expected highest-pay job first, got %s", ranked[0].JobID)
	}
}

func TestBestJobForNode_UrgencyTiebreak(t *testing.T) {
	now := int64(1000)
	req := domain.JobRequirements{JobType: domain.JobGeneralCompute, MinCpuCores: intp(2), EstimatedDurationSec: 60}
	jobs := []domain.Job{
		job("far", "2000000", req, now+100000),
		job("soon", "2000000", req, now+60), // same pay, sooner deadline -> should win
	}
	best := BestJobForNode(cpuNode(), jobs, now, Weights{})
	if best == nil || best.JobID != "soon" {
		t.Fatalf("expected 'soon' to rank first on urgency, got %v", best)
	}
}

func TestBestJobForNode_NoneEligible(t *testing.T) {
	now := int64(1000)
	gpuReq := domain.JobRequirements{JobType: domain.JobInference, MinGpuTier: intp(5), EstimatedDurationSec: 60}
	jobs := []domain.Job{job("gpu", "9000000", gpuReq, now+3600)}
	if best := BestJobForNode(cpuNode(), jobs, now, Weights{}); best != nil {
		t.Errorf("expected no eligible job, got %v", best)
	}
}
