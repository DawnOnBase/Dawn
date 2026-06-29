#!/usr/bin/env bash
# Set production secrets on Fly. COPY this to secrets.sh, fill in REAL values,
# and run it once (and after any rotation). secrets.sh is gitignored — NEVER
# commit real secrets. Secrets are injected as env vars at runtime by Fly.
#
# Prereq: the five apps exist (see deploy/README.md → "Create the apps").
set -euo pipefail

# ── Shared ───────────────────────────────────────────────────────────────────
# Managed Postgres DSN (Supabase or Fly Postgres). sslmode=require for Supabase.
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/dawn?sslmode=require"

# Paid Base RPC (Alchemy / QuickNode / Infura). The API key lives in the URL,
# so treat the whole URL as a secret.
RPC_URL="https://base-sepolia.g.alchemy.com/v2/YOUR_KEY"

# ── proof-service: on-chain settler ──────────────────────────────────────────
# Hot key that signs settle() txns. Fund it for gas; rotate freely (setTreasury
# is separate). Unset it to run verify/record-only (no settlement).
SETTLEMENT_PRIVATE_KEY="0xYOUR_SETTLER_PRIVATE_KEY"
SETTLEMENT_ADDRESS="0xc27C00000000000000000000000000000000651E"  # deployed Settlement

# ── api: x402 payment requirements ───────────────────────────────────────────
TREASURY_ADDRESS="0xYOUR_TREASURY_MULTISIG"

fly secrets set -a dawn-api \
  DATABASE_URL="$DATABASE_URL" RPC_URL="$RPC_URL" TREASURY_ADDRESS="$TREASURY_ADDRESS"

fly secrets set -a dawn-job-queue \
  DATABASE_URL="$DATABASE_URL"

fly secrets set -a dawn-proof-service \
  DATABASE_URL="$DATABASE_URL" RPC_URL="$RPC_URL" \
  SETTLEMENT_ADDRESS="$SETTLEMENT_ADDRESS" SETTLEMENT_PRIVATE_KEY="$SETTLEMENT_PRIVATE_KEY"

fly secrets set -a dawn-indexer \
  DATABASE_URL="$DATABASE_URL" RPC_URL="$RPC_URL"

fly secrets set -a dawn-pricing \
  DATABASE_URL="$DATABASE_URL"

echo "secrets set on all five apps."
