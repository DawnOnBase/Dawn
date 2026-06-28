// Command sign-assignment produces an orchestrator EIP-712 Assignment signature for the M9
// redundant-flow e2e (scripts/e2e_redundant.sh). It computes the committee Merkle root over the
// three operator addresses and signs the Assignment for the deployed Settlement, printing
// ROOT / SIG / ORCH_ADDR for the forge run scripts to consume. This is the on-chain proof that
// the Go orchestrator's signature is accepted by the real contract (not just digest-equal).
//
// Inputs via env: CHAIN_ID, SETTLEMENT, OP0, OP1, OP2, JOBID, INPUTHASH, REDUNDANCY, DEADLINE,
// AMOUNT, BOND, NONCE, ORCH_KEY (0x private key).
package main

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/orchestrator"
)

func main() {
	ops := []domain.Address{env("OP0"), env("OP1"), env("OP2")}

	keyBytes, err := hex.DecodeString(strings.TrimPrefix(env("ORCH_KEY"), "0x"))
	fatal(err)
	priv := secp256k1.PrivKeyFromBytes(keyBytes)

	signer, err := orchestrator.NewSigner(priv, bigEnv("CHAIN_ID"), env("SETTLEMENT"))
	fatal(err)

	c, err := signer.SignCommittee(
		domain.Hex(env("JOBID")), domain.Hex(env("INPUTHASH")), ops,
		uint16(intEnv("REDUNDANCY")), uint64(intEnv("DEADLINE")),
		bigEnv("AMOUNT"), bigEnv("BOND"), bigEnv("NONCE"))
	fatal(err)

	fmt.Printf("ROOT=%s\n", c.OperatorSetRoot)
	fmt.Printf("SIG=%s\n", c.Signature)
	fmt.Printf("ORCH_ADDR=%s\n", signer.Address())
}

func env(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fatal(fmt.Errorf("missing env %s", k))
	}
	return v
}

func intEnv(k string) int {
	n, err := strconv.Atoi(env(k))
	fatal(err)
	return n
}

func bigEnv(k string) *big.Int {
	n, ok := new(big.Int).SetString(env(k), 10)
	if !ok {
		fatal(fmt.Errorf("bad integer env %s=%q", k, os.Getenv(k)))
	}
	return n
}

func fatal(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "sign-assignment:", err)
		os.Exit(1)
	}
}
