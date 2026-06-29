package orchestrator

import (
	"fmt"
	"math/big"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// Signer is the backend's committee authority: it holds the orchestrator EIP-712 key and turns a chosen
// committee into the on-chain Assignment the contract verifies at escrowRedundant (M9 doc #2).
// It is the one root of trust for the redundant flow, so in production the key is a
// multisig/threshold key — this struct is the single-signer shape the e2e + tests exercise.
//
// Signer is immutable after construction and safe for concurrent use.
type Signer struct {
	priv       *secp256k1.PrivateKey
	chainID    *big.Int
	settlement domain.Address
}

// NewSigner binds an orchestrator key to the Settlement deployment it authorizes for. chainID +
// settlement pin the EIP-712 domain, so a signature is only valid for that exact contract/chain.
func NewSigner(priv *secp256k1.PrivateKey, chainID *big.Int, settlement domain.Address) (*Signer, error) {
	if priv == nil {
		return nil, fmt.Errorf("orchestrator: nil private key")
	}
	if chainID == nil {
		return nil, fmt.Errorf("orchestrator: nil chainID")
	}
	if _, err := decodeAddress20(settlement); err != nil {
		return nil, fmt.Errorf("orchestrator: settlement address: %w", err)
	}
	return &Signer{priv: priv, chainID: new(big.Int).Set(chainID), settlement: settlement}, nil
}

// Address is the orchestrator's 0x-lowercase address — must equal the contract's `orchestrator`
// immutable, or every escrowRedundant reverts BAD_ASSIGNMENT.
func (s *Signer) Address() domain.Address { return AddressOf(s.priv) }

// Committee is the signed authorization for a redundant job: the operator set, its Merkle root, and
// the orchestrator signature. It maps 1:1 onto the values stored on domain.Job and the calldata
// escrowRedundant takes.
type Committee struct {
	Operators       []domain.Address
	OperatorSetRoot domain.Hex
	Signature       domain.Hex
}

// SignCommittee builds the sorted-pair Merkle root over `operators` (assignment order preserved) and
// EIP-712-signs the Assignment binding (jobId, inputHash, root, redundancy, deadline, amount, bond,
// nonce). The returned root + per-member proofs (orchestrator.MerkleProof over the SAME operators)
// are what the agent presents at submitProof, so callers MUST keep the operator order stable.
func (s *Signer) SignCommittee(
	jobID, inputHash domain.Hex,
	operators []domain.Address,
	redundancy uint16,
	deadline uint64,
	amount, bond, nonce *big.Int,
) (Committee, error) {
	if int(redundancy) != len(operators) {
		return Committee{}, fmt.Errorf("orchestrator: redundancy %d != committee size %d", redundancy, len(operators))
	}
	root, err := MerkleRoot(operators)
	if err != nil {
		return Committee{}, err
	}
	a := Assignment{
		JobID:           jobID,
		InputHash:       inputHash,
		OperatorSetRoot: root,
		Redundancy:      redundancy,
		Deadline:        deadline,
		Amount:          amount,
		Bond:            bond,
		Nonce:           nonce,
	}
	sig, err := a.Sign(s.priv, s.chainID, s.settlement)
	if err != nil {
		return Committee{}, err
	}
	return Committee{
		Operators:       append([]domain.Address(nil), operators...),
		OperatorSetRoot: root,
		Signature:       sig,
	}, nil
}
