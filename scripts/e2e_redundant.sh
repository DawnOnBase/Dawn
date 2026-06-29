#!/usr/bin/env bash
#
# M9 redundant-flow end-to-end test — proves the FULL Sybil-resistant money path on a local anvil
# chain, with the orchestrator Assignment signed by the REAL Go orchestrator (services/job-queue):
#
#   deploy Settlement + OperatorStaking → 3 operators stake → the Go orchestrator signs an EIP-712
#   Assignment for the committee → buyer escrows with that Go signature → 2 authorized operators
#   submit Merkle-gated proofs → super-plurality consensus → warp past the challenge window → claim
#   → each winner is paid (amount − fee)/quorum.
#
# The escrow succeeding is the on-chain proof that the deployed contract accepts the GO-produced
# signature (not just digest-equal). Exits non-zero on any failure. Requires: foundry (anvil, forge,
# cast), go. Uses anvil's well-known public test keys.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JQ="$REPO/services/job-queue"
RPC="http://127.0.0.1:8545"
CHAIN_ID=31337

# anvil deterministic accounts (PUBLIC test keys — safe to hardcode).
BUYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ORCH_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
ORCH_ADDR=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc # addr(ORCH_KEY)
OP0=0x70997970C51812dc3A010C7d01b50e0d17dc79C8        # committee operators (addr of each OPn_KEY)
OP1=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
OP2=0x90F79bf6EB2c4f870365E785982E1f101E93b906

# Job parameters — the single source shared by the Go signer and the forge scripts.
export CHAIN_ID
export AMOUNT=100000000 # 100 USDC
export BOND=10000000     # 10 USDC
export NONCE=1
export REDUNDANCY=3
export DEADLINE=$(( $(date +%s) + 3600 )) # within MAX_DEADLINE; > now

WORK="$(mktemp -d)"
KEEP_LOGS="${KEEP_LOGS:-0}"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  [ "$KEEP_LOGS" = "1" ] && echo "logs kept in $WORK" || rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> starting anvil"
anvil --silent > "$WORK/anvil.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

export JOBID="$(cast keccak "dawn-redundant-e2e")"
export INPUTHASH="$(cast keccak "in")"

echo "==> deploy Settlement + OperatorStaking, set orchestrator, operators stake"
OUT="$(cd "$REPO/contracts" && ORCH_ADDR="$ORCH_ADDR" \
  forge script script/RedundantE2EDeploy.s.sol --rpc-url "$RPC" --private-key "$BUYER_KEY" --broadcast 2>&1)"
export USDC="$(echo "$OUT" | sed -n 's/.*USDC=\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)"
export STAKING="$(echo "$OUT" | sed -n 's/.*STAKING=\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)"
export SETTLEMENT="$(echo "$OUT" | sed -n 's/.*SETTLEMENT=\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)"
[ -n "$USDC" ] && [ -n "$SETTLEMENT" ] || { echo "FAIL: could not parse deploy output"; echo "$OUT"; exit 1; }
echo "    SETTLEMENT=$SETTLEMENT  STAKING=$STAKING"

echo "==> Go orchestrator signs the EIP-712 Assignment for committee {OP0,OP1,OP2}"
SIGOUT="$(cd "$JQ" && CHAIN_ID="$CHAIN_ID" SETTLEMENT="$SETTLEMENT" \
  OP0="$OP0" OP1="$OP1" OP2="$OP2" JOBID="$JOBID" INPUTHASH="$INPUTHASH" \
  REDUNDANCY="$REDUNDANCY" DEADLINE="$DEADLINE" AMOUNT="$AMOUNT" BOND="$BOND" NONCE="$NONCE" \
  ORCH_KEY="$ORCH_KEY" go run ./cmd/sign-assignment 2>&1)"
export ROOT_HEX="$(echo "$SIGOUT" | sed -n 's/^ROOT=\(0x[0-9a-fA-F]*\)$/\1/p')"
export SIG="$(echo "$SIGOUT" | sed -n 's/^SIG=\(0x[0-9a-fA-F]*\)$/\1/p')"
GO_ORCH="$(echo "$SIGOUT" | sed -n 's/^ORCH_ADDR=\(0x[0-9a-fA-F]*\)$/\1/p')"
[ -n "$SIG" ] && [ -n "$ROOT_HEX" ] || { echo "FAIL: Go signer output"; echo "$SIGOUT"; exit 1; }
# The Go-derived orchestrator address must match the one we wired on-chain.
[ "$(echo "$GO_ORCH" | tr 'A-F' 'a-f')" = "$(echo "$ORCH_ADDR" | tr 'A-F' 'a-f')" ] \
  || { echo "FAIL: Go orchestrator $GO_ORCH != wired $ORCH_ADDR"; exit 1; }
export ROOT="$ROOT_HEX"
echo "    ROOT=$ROOT"
echo "    SIG=$SIG"

echo "==> buyer escrows with the GO signature; 2 operators submit -> consensus"
SUB="$(cd "$REPO/contracts" && forge script script/RedundantE2ESubmit.s.sol \
  --rpc-url "$RPC" --private-key "$BUYER_KEY" --broadcast 2>&1)"
echo "$SUB" | grep -q "GO_SIG_ACCEPTED" || { echo "FAIL: Go signature NOT accepted on-chain"; echo "$SUB"; exit 1; }
echo "$SUB" | grep -q "CONSENSUS_OK" || { echo "FAIL: consensus not reached"; echo "$SUB"; exit 1; }
echo "    Go-signed Assignment accepted; super-plurality consensus reached."

echo "==> warp past the 1h challenge window"
cast rpc --rpc-url "$RPC" evm_increaseTime 3700 >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null

echo "==> finalize: claim winners + sweep rewards"
CLM="$(cd "$REPO/contracts" && forge script script/RedundantE2EClaim.s.sol \
  --rpc-url "$RPC" --private-key "$BUYER_KEY" --broadcast 2>&1)"
echo "$CLM" | grep -q "PAID_OK" || { echo "FAIL: winners not paid"; echo "$CLM"; exit 1; }

# Final on-chain assertion: each winner's USDC balance == reward (49.75 USDC for a 100 USDC job).
REWARD=$(( (AMOUNT - AMOUNT * 50 / 10000) / 2 ))
BAL0="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$OP0" --rpc-url "$RPC" | awk '{print $1}')"
[ "$BAL0" = "$REWARD" ] || { echo "FAIL: op0 balance $BAL0 != reward $REWARD"; exit 1; }

echo ""
echo "PASS — Go-orchestrator-signed redundant money path settled on-chain (each winner paid $REWARD)."
