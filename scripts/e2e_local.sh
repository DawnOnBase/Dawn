#!/usr/bin/env bash
#
# Local end-to-end test (M4) — proves the REAL money path on a local anvil chain,
# with no real funds and anvil's well-known public test keys:
#
#   deploy MockUSDC + Settlement → escrow a job → the agent fetches a real WASM Job
#   Package, runs it in the wasmtime sandbox, signs the EIP-712 proof, and
#   self-settles on-chain → the operator is paid amount − fee.
#
# Asserts: jobStatus == Settled, the operator's USDC balance == payout, and the
# proven outputHash equals keccak(real workload output) — i.e. the sandbox ran real
# compute, not an echo. Exits non-zero on any failure. Requires: foundry (anvil,
# forge, cast), cargo, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$ROOT/apps/agent"
RPC="http://127.0.0.1:8545"
CHAIN_ID=31337

# anvil deterministic accounts (PUBLIC test keys — safe to hardcode).
BUYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # acct 0
NODE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d    # acct 1
NODE_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                          # acct 1
TREASURY=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC                           # acct 2

WORK="$(mktemp -d)"
KEEP_LOGS="${KEEP_LOGS:-0}"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  [ "$KEEP_LOGS" = "1" ] && echo "logs kept in $WORK" || rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> building agent (onchain) + mock backend"
( cd "$AGENT" && cargo build --quiet --features onchain && cargo build --quiet --features onchain --example mock_backend )
AGENT_BIN="$AGENT/target/debug/dawn-agent"
MOCK_BIN="$AGENT/target/debug/examples/mock_backend"

echo "==> starting anvil"
anvil --silent > "$WORK/anvil.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

JOB_ID="$(cast keccak "dawn-local-e2e")"
echo "==> deploy MockUSDC + Settlement + escrow job $JOB_ID"
OUT="$(cd "$ROOT/contracts" && JOB_ID="$JOB_ID" TREASURY_ADDRESS="$TREASURY" \
  forge script script/LocalE2E.s.sol --rpc-url "$RPC" --private-key "$BUYER_KEY" --broadcast 2>&1)"
USDC="$(echo "$OUT" | sed -n 's/.*USDC=\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)"
SETTLEMENT="$(echo "$OUT" | sed -n 's/.*SETTLEMENT=\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)"
[ -n "$USDC" ] && [ -n "$SETTLEMENT" ] || { echo "FAIL: could not parse deploy output"; echo "$OUT"; exit 1; }
echo "    USDC=$USDC  SETTLEMENT=$SETTLEMENT"

echo "==> build + serve a real Job Package (sum.wat over input 'hello')"
printf 'hello' > "$WORK/input.bin"
"$AGENT_BIN" pack "$AGENT/examples/workloads/sum.wat" "$WORK/job.djp" "$WORK/input.bin" >/dev/null
( cd "$WORK" && exec python3 -m http.server 8099 >/dev/null 2>&1 ) &
PIDS+=("$!")
for _ in $(seq 1 25); do curl -sf -o /dev/null "http://127.0.0.1:8099/job.djp" && break; sleep 0.2; done

echo "==> start mock backend (assigns the escrowed job)"
PORT=8092 DAWN_MOCK_JOBID="$JOB_ID" DAWN_MOCK_INPUTREF="http://127.0.0.1:8099/job.djp" \
  "$MOCK_BIN" > "$WORK/mock.log" 2>&1 &
PIDS+=("$!")
sleep 2

echo "==> run agent (background): fetch → sandbox → prove → self-settle"
# Env vars prefix the agent binary directly (external command → exported). Run it in
# the background and poll the chain for settlement, so verification reads on-chain
# truth rather than fragile stdout capture.
DAWN_NODE_KEY="$NODE_KEY" DAWN_SETTLEMENT="$SETTLEMENT" DAWN_RPC_URL="$RPC" \
  DAWN_CHAIN_ID="$CHAIN_ID" DAWN_BACKEND_WS="ws://127.0.0.1:8092/agent" DAWN_FORCE_RUN=1 \
  DAWN_PAYOUT_STORE="$WORK/payout.json" DAWN_OUTBOX="$WORK/outbox.json" \
  "$AGENT_BIN" > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!
PIDS+=("$AGENT_PID")
STATUS=0
for _ in $(seq 1 60); do
  STATUS="$(cast call "$SETTLEMENT" 'jobStatus(bytes32)(uint8)' "$JOB_ID" --rpc-url "$RPC" 2>/dev/null || echo 0)"
  [ "$STATUS" = "2" ] && break
  sleep 0.5
done
kill "$AGENT_PID" 2>/dev/null || true
AGENT_OUT="$(cat "$WORK/agent.log" 2>/dev/null || true)"
echo "$AGENT_OUT" | sed 's/^/    /'

echo "==> verify on-chain settlement"
STATUS="$(cast call "$SETTLEMENT" 'jobStatus(bytes32)(uint8)' "$JOB_ID" --rpc-url "$RPC")"
BAL="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$NODE_ADDR" --rpc-url "$RPC" | awk '{print $1}')"
FEES="$(cast call "$SETTLEMENT" 'accruedFees()(uint256)' --rpc-url "$RPC" | awk '{print $1}')"
# The workload sums the input bytes mod 256: sum("hello")=532, 532&0xff=20=0x14.
WANT_OUTPUT_HASH="$(cast keccak 0x14)"

fail=0
[ "$STATUS" = "2" ] || { echo "FAIL: jobStatus=$STATUS, want 2 (Settled)"; fail=1; }
[ "$BAL" = "995000" ] || { echo "FAIL: operator balance=$BAL, want 995000"; fail=1; }
[ "$FEES" = "5000" ] || { echo "FAIL: accruedFees=$FEES, want 5000"; fail=1; }
echo "$AGENT_OUT" | grep -q "$WANT_OUTPUT_HASH" || { echo "FAIL: agent outputHash != keccak(0x14) — sandbox didn't run the real workload"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo ""
  echo "✅ E2E PASS — escrow → real WASM job → EIP-712 proof → settle → operator paid 995000 (fee 5000)"
  echo "   outputHash $WANT_OUTPUT_HASH proves the sandbox ran real compute (sum of input), not echo."
else
  echo "❌ E2E FAILED"
  echo "--- mock backend log ---"; cat "$WORK/mock.log" 2>/dev/null || true
  echo "--- agent payout/outbox ---"; cat "$WORK/payout.json" "$WORK/outbox.json" 2>/dev/null || true
  exit 1
fi
