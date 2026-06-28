package matching

import (
	"testing"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

func cpu(id string, rel float64, region string) domain.NodeProfile {
	return domain.NodeProfile{NodeID: domain.Address(id), CpuCores: 4, RamGb: 8, Region: region, ReliabilityScore: rel}
}

var anyReq = domain.JobRequirements{JobType: domain.JobGeneralCompute, EstimatedDurationSec: 10}

func ids(c []domain.NodeProfile) map[domain.Address]bool {
	m := map[domain.Address]bool{}
	for _, n := range c {
		m[n.NodeID] = true
	}
	return m
}

func Test_AssignCommittee_picksDistinctReliableNodes(t *testing.T) {
	nodes := []domain.NodeProfile{
		cpu("0xa", 0.9, "us-east"),
		cpu("0xb", 0.5, "us-east"),
		cpu("0xc", 0.8, "eu-west"),
	}
	c := AssignCommittee(nodes, anyReq, 2, 0, Weights{})
	if len(c) != 2 {
		t.Fatalf("want 2, got %d", len(c))
	}
	// top-2 by reliability are 0xa (0.9) and 0xc (0.8)
	got := ids(c)
	if !got["0xa"] || !got["0xc"] {
		t.Fatalf("expected the two most-reliable nodes, got %v", got)
	}
}

func Test_AssignCommittee_dedupesByNodeID(t *testing.T) {
	nodes := []domain.NodeProfile{
		cpu("0xa", 0.9, "us-east"),
		cpu("0xa", 0.9, "us-east"), // same operator, second listing
		cpu("0xb", 0.8, "eu-west"),
	}
	// Only 2 DISTINCT nodes exist, so a committee of 3 is impossible (Sybil cut).
	if c := AssignCommittee(nodes, anyReq, 3, 0, Weights{}); c != nil {
		t.Fatalf("expected nil (only 2 distinct nodes), got %d", len(c))
	}
	if c := AssignCommittee(nodes, anyReq, 2, 0, Weights{}); len(c) != 2 {
		t.Fatalf("want 2 distinct, got %d", len(c))
	}
}

func Test_AssignCommittee_excludesIneligible(t *testing.T) {
	tier := 3
	gpuReq := domain.JobRequirements{JobType: domain.JobInference, EstimatedDurationSec: 10, MinGpuTier: &tier}
	nodes := []domain.NodeProfile{
		cpu("0xa", 0.9, "us-east"), // CPU-only → ineligible for a GPU job
		cpu("0xb", 0.8, "eu-west"),
		{NodeID: "0xg", GpuTier: &tier, CpuCores: 8, RamGb: 32, Region: "us-west", ReliabilityScore: 0.7},
	}
	// Only one GPU node is eligible → can't seat a committee of 2.
	if c := AssignCommittee(nodes, gpuReq, 2, 0, Weights{}); c != nil {
		t.Fatalf("expected nil (one eligible GPU node), got %d", len(c))
	}
}

func Test_AssignCommittee_spreadsRegionsWhenPossible(t *testing.T) {
	nodes := []domain.NodeProfile{
		cpu("0xa", 0.99, "us-east"),
		cpu("0xb", 0.98, "us-east"),
		cpu("0xc", 0.97, "us-east"),
		cpu("0xd", 0.50, "eu-west"),
		cpu("0xe", 0.40, "ap-south"),
	}
	c := AssignCommittee(nodes, anyReq, 3, 0, Weights{})
	if len(c) != 3 {
		t.Fatalf("want 3, got %d", len(c))
	}
	regions := map[string]bool{}
	for _, n := range c {
		regions[n.Region] = true
	}
	// Despite us-east holding the three most reliable nodes, the spread pulls in eu-west + ap-south.
	if len(regions) < 3 {
		t.Fatalf("expected 3 distinct regions, got %v", regions)
	}
}

func Test_AssignCommittee_belowTwoOrTooFewReturnsNil(t *testing.T) {
	nodes := []domain.NodeProfile{cpu("0xa", 0.9, "us-east"), cpu("0xb", 0.8, "eu-west")}
	if AssignCommittee(nodes, anyReq, 1, 0, Weights{}) != nil {
		t.Fatal("m<2 must return nil")
	}
	if AssignCommittee(nodes, anyReq, 5, 0, Weights{}) != nil {
		t.Fatal("too-few-nodes must return nil")
	}
}

func Test_AssignCommittee_stakeFilterExcludesUnderfunded(t *testing.T) {
	nodes := []domain.NodeProfile{
		cpu("0xa", 0.9, "us-east"),
		cpu("0xb", 0.8, "eu-west"),
		cpu("0xc", 0.7, "ap-south"),
	}
	// Only 0xa and 0xc can cover the 10 USDC bond; 0xb (and any unknown operator) is filtered out,
	// so a committee of 3 can no longer be seated but a committee of 2 still can.
	stake := MapStakeOracle{"0xa": 10_000_000, "0xb": 5_000_000, "0xc": 50_000_000}
	if c := AssignCommittee(nodes, anyReq, 3, 0, Weights{}, WithStakeFilter(stake, 10_000_000)); c != nil {
		t.Fatalf("under-bonded node must drop the committee below 3, got %d", len(c))
	}
	c := AssignCommittee(nodes, anyReq, 2, 0, Weights{}, WithStakeFilter(stake, 10_000_000))
	if len(c) != 2 || !ids(c)["0xa"] || !ids(c)["0xc"] {
		t.Fatalf("expected the two staked nodes 0xa,0xc, got %v", ids(c))
	}
}

func Test_AssignCommittee_nilStakeFilterIsNoop(t *testing.T) {
	nodes := []domain.NodeProfile{cpu("0xa", 0.9, "us-east"), cpu("0xb", 0.8, "eu-west")}
	// A nil oracle must not exclude anyone (safe to pass an unconfigured filter).
	if c := AssignCommittee(nodes, anyReq, 2, 0, Weights{}, WithStakeFilter(nil, 1_000_000)); len(c) != 2 {
		t.Fatalf("nil oracle should be a no-op, got %d", len(c))
	}
}

// CommitteeAddresses preserves order so the Merkle proof indices line up.
func Test_CommitteeAddresses_preservesOrder(t *testing.T) {
	c := []domain.NodeProfile{cpu("0xc", 0, "r"), cpu("0xa", 0, "r")}
	got := CommitteeAddresses(c)
	if got[0] != "0xc" || got[1] != "0xa" {
		t.Fatalf("order not preserved: %v", got)
	}
}
