package coordinator

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// HelloAuthMessage is the canonical HELLO_AUTH v1 payload a node signs to
// authenticate (EIP-191 personal_sign). It MUST stay byte-identical to the
// signer side in apps/agent/src/wallet.rs (hello_auth_message) and
// packages/shared/src/protocol.ts (helloAuthMessage).
//
// v1 is replayable (no nonce/timestamp); a nonce is required before opening to
// untrusted nodes — tracked as the auth-hardening follow-up.
func HelloAuthMessage(nodeID domain.Address) string {
	return "Dawn agent hello\nnode: " + string(nodeID)
}

// EIP191Auth verifies a node's `hello` signature by recovering the signer from
// the EIP-191 personal_sign of HelloAuthMessage(nodeID) and asserting it equals
// the claimed nodeId . This is the recovery side of the scheme
// the Rust agent signs; the SAME key signs EIP-712 job proofs, so the operator
// paid on-chain is exactly the node that authenticated here.
type EIP191Auth struct{}

func (EIP191Auth) Verify(nodeID domain.Address, sig domain.Hex) error {
	if nodeID == "" {
		return errors.New("auth: empty nodeId")
	}
	if _, err := decodeAddress(string(nodeID)); err != nil {
		return fmt.Errorf("auth: bad nodeId: %w", err)
	}

	raw, err := decodeHexBytes(string(sig))
	if err != nil {
		return fmt.Errorf("auth: bad signature hex: %w", err)
	}
	if len(raw) != 65 {
		return fmt.Errorf("auth: signature must be 65 bytes, got %d", len(raw))
	}

	// Ethereum layout is r‖s‖v with v ∈ {27,28} (tolerate the 0/1 form too).
	v := raw[64]
	if v < 27 {
		v += 27
	}
	if v != 27 && v != 28 {
		return fmt.Errorf("auth: invalid recovery id %d", raw[64])
	}

	// decred's RecoverCompact wants [recoveryCode‖r‖s] with the code first.
	compact := make([]byte, 65)
	compact[0] = v
	copy(compact[1:33], raw[0:32])
	copy(compact[33:65], raw[32:64])

	digest := eip191Digest([]byte(HelloAuthMessage(nodeID)))
	pub, _, err := ecdsa.RecoverCompact(compact, digest)
	if err != nil {
		return fmt.Errorf("auth: recover: %w", err)
	}

	recovered := addressFromPubKey(pub)
	if !strings.EqualFold(recovered, string(nodeID)) {
		return fmt.Errorf("auth: signature does not match nodeId (recovered %s)", recovered)
	}
	return nil
}

// eip191Digest is keccak256 of the EIP-191 personal-sign framing of msg:
// "\x19Ethereum Signed Message:\n" + len(msg) + msg.
func eip191Digest(msg []byte) []byte {
	framed := append([]byte("\x19Ethereum Signed Message:\n"+strconv.Itoa(len(msg))), msg...)
	h := sha3.NewLegacyKeccak256()
	h.Write(framed)
	return h.Sum(nil)
}

// addressFromPubKey derives the 0x-lowercase Ethereum address from a public key:
// last 20 bytes of keccak256(uncompressed pubkey without the 0x04 prefix).
func addressFromPubKey(pub *secp256k1.PublicKey) string {
	uncompressed := pub.SerializeUncompressed() // 65 bytes: 0x04 ‖ X ‖ Y
	h := sha3.NewLegacyKeccak256()
	h.Write(uncompressed[1:])
	sum := h.Sum(nil)
	return "0x" + hex.EncodeToString(sum[12:])
}

// decodeHexBytes decodes a 0x-prefixed (or bare) hex string to bytes.
func decodeHexBytes(s string) ([]byte, error) {
	return hex.DecodeString(strings.TrimPrefix(s, "0x"))
}

// decodeAddress validates a 20-byte 0x-prefixed hex address.
func decodeAddress(s string) ([]byte, error) {
	b, err := decodeHexBytes(s)
	if err != nil {
		return nil, err
	}
	if len(b) != 20 {
		return nil, fmt.Errorf("expected 20-byte address, got %d", len(b))
	}
	return b, nil
}
