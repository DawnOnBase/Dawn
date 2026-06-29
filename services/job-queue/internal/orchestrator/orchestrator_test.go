package orchestrator

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// Reference values printed by contracts/script/PrintM9Ref.s.sol against Settlement.sol. If the
// contract's Assignment typehash / domain / Merkle ever change, regenerate these (and they MUST,
// because this test is the byte-for-byte cross-check that the orchestrator authorizes exactly what
// the contract verifies).
const (
	refChainID    = 31337
	refSettlement = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3"
	refDomSep     = "0x76d1ff340515e22b3f1e6b6d81f81c2d781c4158919d836d9f31dd5f02197214"
	refDigest     = "0x83fc23d63716363e66be8c2a2a40624f992a16a1799b77760702789e0f7bdce2"
	refRoot2      = "0x4beda981c9d34f2dd099131be6049a1d87676d227e63f4a409ee629043314b4f"
	refRoot3      = "0xcbf843e9efe7be41ca4d3a03347d27e7bb96d83ae75b3b36983ad907d2109c65"

	op0 = "0x1111111111111111111111111111111111111111"
	op1 = "0x2222222222222222222222222222222222222222"
	op2 = "0x3333333333333333333333333333333333333333"
)

func hx(b []byte) domain.Hex { return domain.Hex("0x" + hex.EncodeToString(b)) }

// The exact inputs PrintM9Ref.s.sol signs.
func fixtureAssignment() Assignment {
	return Assignment{
		JobID:           hx(keccak([]byte("job"))),
		InputHash:       hx(keccak([]byte("in"))),
		OperatorSetRoot: hx(keccak([]byte("opset"))),
		Redundancy:      3,
		Deadline:        1000000,
		Amount:          big.NewInt(100000000),
		Bond:            big.NewInt(10000000),
		Nonce:           big.NewInt(1),
	}
}

func Test_DomainSeparator_matchesContract(t *testing.T) {
	got, err := DomainSeparator(big.NewInt(refChainID), refSettlement)
	if err != nil {
		t.Fatal(err)
	}
	if h := hx(got); !strings.EqualFold(string(h), refDomSep) {
		t.Fatalf("domain separator mismatch\n got %s\nwant %s", h, refDomSep)
	}
}

func Test_AssignmentDigest_matchesContract(t *testing.T) {
	got, err := fixtureAssignment().Digest(big.NewInt(refChainID), refSettlement)
	if err != nil {
		t.Fatal(err)
	}
	if h := hx(got); !strings.EqualFold(string(h), refDigest) {
		t.Fatalf("assignment digest mismatch — Go and Settlement.sol disagree\n got %s\nwant %s", h, refDigest)
	}
}

func Test_MerkleRoot_matchesContract(t *testing.T) {
	root2, err := MerkleRoot([]domain.Address{op0, op1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(string(root2), refRoot2) {
		t.Fatalf("2-committee root mismatch\n got %s\nwant %s", root2, refRoot2)
	}
	root3, err := MerkleRoot([]domain.Address{op0, op1, op2})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(string(root3), refRoot3) {
		t.Fatalf("3-committee root mismatch\n got %s\nwant %s", root3, refRoot3)
	}
}

// MerkleProof for every member re-folds (sorted-pair) to the root — the same fold
// Settlement._verifyMembership performs.
func Test_MerkleProof_verifiesAgainstRoot(t *testing.T) {
	ops := []domain.Address{op0, op1, op2}
	root, _ := MerkleRoot(ops)
	rootBytes, _ := decodeBytes32(domain.Hex(root))
	for idx := range ops {
		proof, err := MerkleProof(ops, idx)
		if err != nil {
			t.Fatal(err)
		}
		computed, _ := decodeAddress20(ops[idx])
		computed = keccak(computed)
		for _, p := range proof {
			pb, _ := decodeBytes32(p)
			computed = hashPair(computed, pb)
		}
		if hex.EncodeToString(computed) != hex.EncodeToString(rootBytes) {
			t.Fatalf("proof for idx %d does not reproduce the root", idx)
		}
	}
}

func Test_Sign_Recover_roundtripLowS(t *testing.T) {
	// Deterministic fixed key (32 bytes, < N).
	keyBytes := make([]byte, 32)
	for i := range keyBytes {
		keyBytes[i] = 0x11
	}
	priv := secp256k1.PrivKeyFromBytes(keyBytes)
	orch := AddressOf(priv)

	a := fixtureAssignment()
	sig, err := a.Sign(priv, big.NewInt(refChainID), refSettlement)
	if err != nil {
		t.Fatal(err)
	}

	// 65 bytes, v ∈ {27,28}, low-s (the contract's _recover guards).
	raw, _ := decodeHexBytes(string(sig))
	if len(raw) != 65 {
		t.Fatalf("sig length %d", len(raw))
	}
	if raw[64] != 27 && raw[64] != 28 {
		t.Fatalf("v = %d, want 27/28", raw[64])
	}
	s := new(big.Int).SetBytes(raw[32:64])
	if s.Cmp(halfN) > 0 {
		t.Fatal("signature is high-s; contract would reject it")
	}

	digest, _ := a.Digest(big.NewInt(refChainID), refSettlement)
	recovered, err := Recover(digest, sig)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(string(recovered), string(orch)) {
		t.Fatalf("recovered %s, want orchestrator %s", recovered, orch)
	}
}

func Test_Sign_wrongKeyRecoversDifferentAddress(t *testing.T) {
	k1 := make([]byte, 32)
	k1[31] = 0x01
	k2 := make([]byte, 32)
	k2[31] = 0x02
	p1 := secp256k1.PrivKeyFromBytes(k1)
	p2 := secp256k1.PrivKeyFromBytes(k2)

	a := fixtureAssignment()
	sig, _ := a.Sign(p1, big.NewInt(refChainID), refSettlement)
	digest, _ := a.Digest(big.NewInt(refChainID), refSettlement)
	recovered, _ := Recover(digest, sig)
	if strings.EqualFold(string(recovered), string(AddressOf(p2))) {
		t.Fatal("recovered the wrong signer — forgery would pass")
	}
}
