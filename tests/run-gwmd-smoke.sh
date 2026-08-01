#!/usr/bin/env bash
# Wrapper that runs the gwmd smoke test on the VM host (not in a
# container). The host has curl + jq + docker + node, so we don't need
# to spin up a one-shot container — the test script invokes curl and
# jq directly, and uses `docker exec` for the sidecar stub scan hook.
#
# Run from /srv/umg on the VM:
#   bash tests/run-gwmd-smoke.sh
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

# API is reachable on localhost via the reverse-proxy port 8083.
export BASE="${BASE:-http://localhost:8083}"
export STUB_BASE="${STUB_BASE:-http://localhost:3000}"

bash tests/curl-provision-gwmd.sh
