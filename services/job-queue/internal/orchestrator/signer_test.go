package orchestrator

import (
	"math/big"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

func testSigner(t *testing.T) *Signer {
	t.Helper()
	keyBytes := make([]byte, 32)
	for i := range keyBytes {
		keyBytes[i] = 0x11
	}
	priv := secp256k1.PrivKeyFromBytes(keyBytes)
	s, err := NewSigner(priv, big.NewInt(refChainID), refSettlement)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// SignCommittee must produce the SAME root the standalone MerkleRoot does, and a signature that
// recovers to the orchestrator address — i.e. it composes the verified primitives correctly.
func Test_SignCommittee_rootAndSignatureRecover(t *testing.T) {
	s := testSigner(t)
	ops := []domain.Address{op0, op1, op2}

	c, err := s.SignCommittee(
		hx(keccak([]byte("job"))), hx(keccak([]byte("in"))), ops,
		3, 1000000, big.NewInt(100000000), big.NewInt(10000000), big.NewInt(1))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(string(c.OperatorSetRoot), refRoot3) {
		t.Fatalf("root mismatch\n got %s\nwant %s", c.OperatorSetRoot, refRoot3)
	}

	// Re-derive the digest the way the contract does and recover the signer.
	a := Assignment{
		JobID: hx(keccak([]byte("job"))), InputHash: hx(keccak([]byte("in"))),
		OperatorSetRoot: c.OperatorSetRoot, Redundancy: 3, Deadline: 1000000,
		Amount: big.NewInt(100000000), Bond: big.NewInt(10000000), Nonce: big.NewInt(1),
	}
	digest, err := a.Digest(big.NewInt(refChainID), refSettlement)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := Recover(digest, c.Signature)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(string(recovered), string(s.Address())) {
		t.Fatalf("recovered %s, want orchestrator %s", recovered, s.Address())
	}
}

// The committee size MUST equal redundancy — a mismatch means the matcher and the signed M disagree,
// which the contract would later reject; fail fast at signing instead.
func Test_SignCommittee_rejectsSizeMismatch(t *testing.T) {
	s := testSigner(t)
	_, err := s.SignCommittee(
		hx(keccak([]byte("job"))), hx(keccak([]byte("in"))),
		[]domain.Address{op0, op1}, 3, 1000000,
		big.NewInt(1), big.NewInt(1), big.NewInt(1))
	if err == nil {
		t.Fatal("expected error when redundancy != committee size")
	}
}

func Test_NewSigner_rejectsBadSettlement(t *testing.T) {
	keyBytes := make([]byte, 32)
	keyBytes[31] = 0x01
	priv := secp256k1.PrivKeyFromBytes(keyBytes)
	if _, err := NewSigner(priv, big.NewInt(1), "0xnotanaddress"); err == nil {
		t.Fatal("expected error for malformed settlement address")
	}
}
