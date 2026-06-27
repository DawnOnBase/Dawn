#!/usr/bin/env bash
# coverage-gate.sh — enforce a minimum line coverage on the money contract(s).
#
# `forge coverage` has no native --fail-under, and its Total is dragged down by
# deploy scripts (script/*.sol are never unit-tested, by design). So we gate the
# metric that matters: line coverage of every instrumented file under src/
# (which today is Settlement.sol; interfaces have no executable lines and never
# appear in the lcov report).
#
# Usage (--ir-minimum: coverage disables the optimizer, which re-triggers stack-too-deep on the
# M9 redundant-flow code; viaIR-minimum resolves it):
#   forge coverage --ir-minimum --report lcov --report summary
#   ./coverage-gate.sh [lcov.info]
#
# Tunable via env:
#   COVERAGE_MIN_LINES   minimum % line coverage per src/ file (default 95)
set -euo pipefail

THRESHOLD="${COVERAGE_MIN_LINES:-95}"
LCOV="${1:-lcov.info}"

if [[ ! -f "$LCOV" ]]; then
  echo "coverage-gate: '$LCOV' not found — run 'forge coverage --report lcov' first" >&2
  exit 2
fi

echo "coverage-gate: requiring >= ${THRESHOLD}% line coverage for every src/ file"

awk -v threshold="$THRESHOLD" '
  /^SF:/ { file = substr($0, 4); lf = 0; lh = 0 }
  /^LF:/ { lf = substr($0, 4) + 0 }
  /^LH:/ { lh = substr($0, 4) + 0 }
  /^end_of_record/ {
    if (file ~ /(^|\/)src\// && lf > 0) {
      seen++
      pct = 100.0 * lh / lf
      printf "  %-32s %7.2f%%  (%d/%d lines)\n", file, pct, lh, lf
      # +1e-9 guards against float equality at exactly the threshold.
      if (pct + 1e-9 < threshold) { bad[file] = pct; nbad++ }
    }
  }
  END {
    if (seen == 0) {
      print "coverage-gate: FAIL — no instrumented src/ files found in the report" > "/dev/stderr"
      exit 1
    }
    if (nbad > 0) {
      printf "\ncoverage-gate: FAIL — %d file(s) below %s%% line coverage\n", nbad, threshold > "/dev/stderr"
      exit 1
    }
    printf "\ncoverage-gate: PASS — all %d src/ file(s) >= %s%% line coverage\n", seen, threshold
  }
' "$LCOV"
