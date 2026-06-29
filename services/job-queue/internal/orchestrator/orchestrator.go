// Package orchestrator is the backend's committee authority for the M9 redundant-execution flow
// (the redundant-execution design). It builds the sorted-pair Merkle root over an assigned
// committee and EIP-712-signs the on-chain Assignment that authorizes it — the cryptographic
// form of the trust the buyer already places in the matcher.
//
// CORRECTNESS ANCHOR: the digest + Merkle root here are cross-checked byte-for-byte against
// Settlement.sol (contracts/script/PrintM9Ref.s.sol → orchestrator_test.go), exactly as the node
// proof digest is cross-checked across Solidity/TS/Rust. Do NOT change the type strings or the
// encoding without updating the contract + that fixture in lockstep (shared interface).
package orchestrator

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// EIP-712 type strings — MUST stay byte-identical to Settlement.sol.
const (
	domainName     = "Dawn Settlement"
	domainVersion  = "1"
	assignmentType = "Assignment(bytes32 jobId,bytes32 inputHash,bytes32 operatorSetRoot," +
		"uint16 redundancy,uint64 deadline,uint256 amount,uint256 bond,uint256 nonce)"
	domainType = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)

// secp256k1 order N and its half (the contract's low-s malleability guard, _HALF_N).
var (
	curveN = mustHex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
	halfN  = new(big.Int).Rsh(curveN, 1)

	domainTypehash     = keccak([]byte(domainType))
	assignmentTypehash = keccak([]byte(assignmentType))
	hashedName         = keccak([]byte(domainName))
	hashedVersion      = keccak([]byte(domainVersion))
)

// Assignment mirrors ISettlement.RedundantEscrow + Settlement._ASSIGNMENT_TYPEHASH (field order
// matters — it is the signed struct). Amount/Bond/Nonce are USDC base units / counters as big.Int.
type Assignment struct {
	JobID           domain.Hex
	InputHash       domain.Hex
	OperatorSetRoot domain.Hex
	Redundancy      uint16
	Deadline        uint64
	Amount          *big.Int
	Bond            *big.Int
	Nonce           *big.Int
}

// DomainSeparator for the Settlement contract at `settlement` on `chainID` (== Settlement.domainSeparator()).
func DomainSeparator(chainID *big.Int, settlement domain.Address) ([]byte, error) {
	addr, err := decodeAddress20(settlement)
	if err != nil {
		return nil, fmt.Errorf("orchestrator: settlement address: %w", err)
	}
	var buf []byte
	buf = append(buf, domainTypehash...)
	buf = append(buf, hashedName...)
	buf = append(buf, hashedVersion...)
	buf = append(buf, leftPad32(chainID.Bytes())...)
	buf = append(buf, leftPad32(addr)...)
	return keccak(buf), nil
}

func (a Assignment) structHash() ([]byte, error) {
	jobID, err := decodeBytes32(a.JobID)
	if err != nil {
		return nil, fmt.Errorf("jobId: %w", err)
	}
	inputHash, err := decodeBytes32(a.InputHash)
	if err != nil {
		return nil, fmt.Errorf("inputHash: %w", err)
	}
	root, err := decodeBytes32(a.OperatorSetRoot)
	if err != nil {
		return nil, fmt.Errorf("operatorSetRoot: %w", err)
	}
	if a.Amount == nil || a.Bond == nil || a.Nonce == nil {
		return nil, errors.New("orchestrator: amount/bond/nonce must be set")
	}
	var buf []byte
	buf = append(buf, assignmentTypehash...)
	buf = append(buf, jobID...)
	buf = append(buf, inputHash...)
	buf = append(buf, root...)
	buf = append(buf, leftPad32(new(big.Int).SetUint64(uint64(a.Redundancy)).Bytes())...)
	buf = append(buf, leftPad32(new(big.Int).SetUint64(a.Deadline).Bytes())...)
	buf = append(buf, leftPad32(a.Amount.Bytes())...)
	buf = append(buf, leftPad32(a.Bond.Bytes())...)
	buf = append(buf, leftPad32(a.Nonce.Bytes())...)
	return keccak(buf), nil
}

// Digest is the EIP-712 digest the orchestrator signs — equal to Settlement.assignmentDigest(e).
func (a Assignment) Digest(chainID *big.Int, settlement domain.Address) ([]byte, error) {
	domSep, err := DomainSeparator(chainID, settlement)
	if err != nil {
		return nil, err
	}
	sh, err := a.structHash()
	if err != nil {
		return nil, err
	}
	buf := []byte{0x19, 0x01}
	buf = append(buf, domSep...)
	buf = append(buf, sh...)
	return keccak(buf), nil
}

// Sign returns the 65-byte r‖s‖v signature (low-s, v∈{27,28}) the contract accepts.
func (a Assignment) Sign(priv *secp256k1.PrivateKey, chainID *big.Int, settlement domain.Address) (domain.Hex, error) {
	digest, err := a.Digest(chainID, settlement)
	if err != nil {
		return "", err
	}
	compact := ecdsa.SignCompact(priv, digest, false) // [V, R(32), S(32)], V = 27+recid
	v := compact[0]
	r := new(big.Int).SetBytes(compact[1:33])
	s := new(big.Int).SetBytes(compact[33:65])
	// Enforce EIP-2 low-s: if s > n/2, use n-s and flip the recovery bit (the contract rejects high-s).
	if s.Cmp(halfN) > 0 {
		s.Sub(curveN, s)
		if v == 27 {
			v = 28
		} else {
			v = 27
		}
	}
	sig := make([]byte, 65)
	copy(sig[0:32], leftPad32(r.Bytes()))
	copy(sig[32:64], leftPad32(s.Bytes()))
	sig[64] = v
	return domain.Hex("0x" + hex.EncodeToString(sig)), nil
}

// Recover returns the 0x-lowercase address that produced `sig` over `digest` (mirrors the
// contract's guarded ecrecover: 65 bytes, v∈{27,28}).
func Recover(digest []byte, sig domain.Hex) (domain.Address, error) {
	raw, err := decodeHexBytes(string(sig))
	if err != nil {
		return "", err
	}
	if len(raw) != 65 {
		return "", fmt.Errorf("orchestrator: signature must be 65 bytes, got %d", len(raw))
	}
	v := raw[64]
	if v < 27 {
		v += 27
	}
	if v != 27 && v != 28 {
		return "", fmt.Errorf("orchestrator: invalid recovery id %d", raw[64])
	}
	compact := make([]byte, 65)
	compact[0] = v
	copy(compact[1:33], raw[0:32])
	copy(compact[33:65], raw[32:64])
	pub, _, err := ecdsa.RecoverCompact(compact, digest)
	if err != nil {
		return "", fmt.Errorf("orchestrator: recover: %w", err)
	}
	return addressFromPubKey(pub), nil
}

// AddressOf derives the 0x-lowercase address of a private key.
func AddressOf(priv *secp256k1.PrivateKey) domain.Address {
	return addressFromPubKey(priv.PubKey())
}

// --- sorted-pair Merkle (leaf = keccak256(20-byte addr), promote-odd) — matches
//     Settlement._verifyMembership + the Solidity test harness exactly. ---

// MerkleRoot is the operatorSetRoot committed in the Assignment for `operators` (order-sensitive).
func MerkleRoot(operators []domain.Address) (domain.Hex, error) {
	level, err := leaves(operators)
	if err != nil {
		return "", err
	}
	if len(level) == 0 {
		return "", errors.New("orchestrator: empty committee")
	}
	for len(level) > 1 {
		level = nextLevel(level)
	}
	return hex32(level[0]), nil
}

// MerkleProof returns the membership proof for `operators[idx]` against MerkleRoot(operators).
func MerkleProof(operators []domain.Address, idx int) ([]domain.Hex, error) {
	level, err := leaves(operators)
	if err != nil {
		return nil, err
	}
	if idx < 0 || idx >= len(level) {
		return nil, fmt.Errorf("orchestrator: index %d out of range %d", idx, len(level))
	}
	proof := []domain.Hex{}
	for len(level) > 1 {
		sib := idx ^ 1
		if sib < len(level) {
			proof = append(proof, hex32(level[sib]))
		}
		idx /= 2
		level = nextLevel(level)
	}
	return proof, nil
}

func leaves(operators []domain.Address) ([][]byte, error) {
	out := make([][]byte, len(operators))
	for i, op := range operators {
		a, err := decodeAddress20(op)
		if err != nil {
			return nil, fmt.Errorf("operator %d: %w", i, err)
		}
		out[i] = keccak(a)
	}
	return out, nil
}

func nextLevel(level [][]byte) [][]byte {
	n := (len(level) + 1) / 2
	next := make([][]byte, n)
	for i := 0; i < n; i++ {
		li := 2 * i
		ri := li + 1
		if ri < len(level) {
			next[i] = hashPair(level[li], level[ri])
		} else {
			next[i] = level[li] // promote odd
		}
	}
	return next
}

func hashPair(a, b []byte) []byte {
	if bytesLE(a, b) {
		return keccak(append(append([]byte{}, a...), b...))
	}
	return keccak(append(append([]byte{}, b...), a...))
}

func bytesLE(a, b []byte) bool { // a <= b as big-endian uint256
	return new(big.Int).SetBytes(a).Cmp(new(big.Int).SetBytes(b)) <= 0
}

// --- low-level helpers (mirror coordinator/eip191auth.go) ---

func keccak(b []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(b)
	return h.Sum(nil)
}

func addressFromPubKey(pub *secp256k1.PublicKey) domain.Address {
	uncompressed := pub.SerializeUncompressed() // 0x04 ‖ X ‖ Y
	sum := keccak(uncompressed[1:])
	return domain.Address("0x" + hex.EncodeToString(sum[12:]))
}

func leftPad32(b []byte) []byte {
	if len(b) >= 32 {
		return b[len(b)-32:]
	}
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func hex32(b []byte) domain.Hex {
	return domain.Hex("0x" + hex.EncodeToString(leftPad32(b)))
}

func decodeHexBytes(s string) ([]byte, error) {
	return hex.DecodeString(strings.TrimPrefix(strings.ToLower(s), "0x"))
}

func decodeBytes32(s domain.Hex) ([]byte, error) {
	b, err := decodeHexBytes(string(s))
	if err != nil {
		return nil, err
	}
	if len(b) != 32 {
		return nil, fmt.Errorf("expected 32 bytes, got %d", len(b))
	}
	return b, nil
}

func decodeAddress20(s domain.Address) ([]byte, error) {
	b, err := decodeHexBytes(string(s))
	if err != nil {
		return nil, err
	}
	if len(b) != 20 {
		return nil, fmt.Errorf("expected 20-byte address, got %d", len(b))
	}
	return b, nil
}

func mustHex(s string) *big.Int {
	n, ok := new(big.Int).SetString(s, 16)
	if !ok {
		panic("orchestrator: bad hex constant " + s)
	}
	return n
}
