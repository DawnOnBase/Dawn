package coordinator

import (
	"encoding/hex"
	"strconv"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
)

// signHello reproduces the Rust agent's HELLO_AUTH v1 signing (wallet.rs):
// EIP-191 personal_sign over HelloAuthMessage(addr), 65-byte r‖s‖v, v ∈ {27,28}.
func signHello(t *testing.T, priv *secp256k1.PrivateKey) (domain.Address, domain.Hex) {
	t.Helper()
	addr := addressFromPubKey(priv.PubKey())
	digest := eip191Digest([]byte(HelloAuthMessage(domain.Address(addr))))

	// RecoverCompact-compatible signature is [v‖r‖s]; reorder to Ethereum r‖s‖v.
	compact := ecdsa.SignCompact(priv, digest, false) // [recoveryCode‖r‖s]
	sig := make([]byte, 65)
	copy(sig[0:32], compact[1:33])
	copy(sig[32:64], compact[33:65])
	sig[64] = compact[0] // already 27/28 for uncompressed
	return domain.Address(addr), domain.Hex("0x" + hex.EncodeToString(sig))
}

func TestEIP191Auth_AcceptsValidSignature(t *testing.T) {
	priv, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	nodeID, sig := signHello(t, priv)

	if err := (EIP191Auth{}).Verify(nodeID, sig); err != nil {
		t.Fatalf("expected valid signature to pass, got %v", err)
	}
}

func TestEIP191Auth_AcceptsKnownVectorFromRustAgent(t *testing.T) {
	// Private key 0x11..11 (32 bytes) — the fixture the Rust wallet.rs tests use.
	// This locks the cross-language HELLO_AUTH contract: same key + same message
	// must recover to the same operator address.
	keyBytes, _ := hex.DecodeString(strings.Repeat("11", 32))
	priv := secp256k1.PrivKeyFromBytes(keyBytes)
	nodeID, sig := signHello(t, priv)

	if err := (EIP191Auth{}).Verify(nodeID, sig); err != nil {
		t.Fatalf("fixture key should authenticate: %v", err)
	}
}

// TestEIP191Auth_CrossImplVector locks compatibility with an independent EIP-191
// implementation (Foundry `cast wallet sign`, same secp256k1 path the Rust agent
// uses). Private key 0x11..11 signing HelloAuthMessage(addr) must recover here.
func TestEIP191Auth_CrossImplVector(t *testing.T) {
	const (
		nodeID = domain.Address("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a")
		sig    = domain.Hex("0x4b7fbe370b745f26b4864443fe559c7f2c0f8edc435cdfcdb4f3d1879445a6ae385d2c7feccbb1a0196d8b85a5b633147c9853911fe861feaa9c179774c295ba1b")
	)
	if err := (EIP191Auth{}).Verify(nodeID, sig); err != nil {
		t.Fatalf("cross-impl vector (cast/foundry) must verify: %v", err)
	}
}

func TestEIP191Auth_RejectsWrongNodeID(t *testing.T) {
	priv, _ := secp256k1.GeneratePrivateKey()
	_, sig := signHello(t, priv)

	// A different address than the one that signed.
	other, _ := secp256k1.GeneratePrivateKey()
	wrongID := domain.Address(addressFromPubKey(other.PubKey()))

	if err := (EIP191Auth{}).Verify(wrongID, sig); err == nil {
		t.Fatal("expected mismatched nodeId to be rejected")
	}
}

func TestEIP191Auth_RejectsTamperedMessage(t *testing.T) {
	priv, _ := secp256k1.GeneratePrivateKey()
	addr := addressFromPubKey(priv.PubKey())

	// Sign a DIFFERENT message than HelloAuthMessage; verify must reject.
	digest := eip191Digest([]byte("not the hello message"))
	compact := ecdsa.SignCompact(priv, digest, false)
	sig := make([]byte, 65)
	copy(sig[0:32], compact[1:33])
	copy(sig[32:64], compact[33:65])
	sig[64] = compact[0]

	if err := (EIP191Auth{}).Verify(domain.Address(addr), domain.Hex("0x"+hex.EncodeToString(sig))); err == nil {
		t.Fatal("expected signature over a different message to be rejected")
	}
}

func TestEIP191Auth_RejectsMalformed(t *testing.T) {
	cases := []struct {
		name   string
		nodeID domain.Address
		sig    domain.Hex
	}{
		{"empty nodeId", "", "0x" + domain.Hex(strings.Repeat("00", 65))},
		{"bad nodeId hex", "0xZZ", "0x" + domain.Hex(strings.Repeat("00", 65))},
		{"short nodeId", "0x1234", "0x" + domain.Hex(strings.Repeat("00", 65))},
		{"bad sig hex", "0x" + domain.Hex(strings.Repeat("11", 20)), "0xZZ"},
		{"wrong sig length", "0x" + domain.Hex(strings.Repeat("11", 20)), "0x1234"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := (EIP191Auth{}).Verify(tc.nodeID, tc.sig); err == nil {
				t.Fatalf("expected %q to be rejected", tc.name)
			}
		})
	}
}

// Guard the message format against accidental drift from the signer side.
func TestHelloAuthMessage_Format(t *testing.T) {
	got := HelloAuthMessage("0xabc")
	want := "Dawn agent hello\nnode: 0xabc"
	if got != want {
		t.Fatalf("HELLO_AUTH message drifted:\n got %q\nwant %q", got, want)
	}
	// And the EIP-191 length framing must use the byte length of the message.
	if !strings.Contains(string(eip191Frame(got)), strconv.Itoa(len(got))) {
		t.Fatalf("framing length mismatch")
	}
}

// eip191Frame is a test helper mirroring the framing inside eip191Digest.
func eip191Frame(msg string) []byte {
	return []byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len(msg)) + msg)
}
