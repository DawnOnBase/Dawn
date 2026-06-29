#!/usr/bin/env bash
# Deploy all Dawn backend services to Fly. Run from ANYWHERE — it cd's to the
# repo root so the Docker build context resolves @dawn/shared.
#
# Prereqs (one-time, see deploy/README.md):
#   - flyctl installed + `fly auth login`
#   - the five apps created (`fly apps create dawn-<svc>`)
#   - secrets set (./secrets.sh)
#
# Order matters: job-queue first so its release_command applies DB migrations
# before any service serves traffic against the schema.
set -euo pipefail

cd "$(dirname "$0")/../.."  # repo root

SERVICES=(job-queue proof-service api indexer pricing)

for svc in "${SERVICES[@]}"; do
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "  deploying dawn-$svc"
  echo "════════════════════════════════════════════════════════"
  fly deploy -c "deploy/fly/$svc.toml" --remote-only
done

echo ""
echo "all services deployed. Health: fly checks list -a dawn-<svc>"
