#!/usr/bin/env bash
# Regenerates docker-compose.portainer.yml — the single-file form of the stack,
# for Portainer and anything else that deploys one compose file.
#
# Run from the repository root after changing either compose file:
#   bash infra/scripts/gen-portainer-compose.sh
#
# Two things matter here and are easy to get wrong by hand:
#
#   --no-interpolate keeps every ${VAR} as a placeholder. Without it the
#   generator bakes the *local* .env — real passwords and webhook secrets —
#   into a file that then gets committed.
#
#   `docker compose config` rewrites every relative path to an absolute one
#   against the project directory. Left alone, the result carries this
#   machine's paths (/srv/umg/...) and fails on any other host with a mount
#   error about a missing source. Both build contexts *and* bind mounts have
#   to be made relative again.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd -P)"
OUT="docker-compose.portainer.yml"

HEADER="# Single-file stack for Portainer (and anything else that deploys one compose
# file).
#
# GENERATED — do not edit. Regenerate with:
#   bash infra/scripts/gen-portainer-compose.sh
#
# Why this exists: the stack is normally two files, because the base defines
# dev stubs and the prod override swaps in the real vendor images using the
# \`!reset\` / \`!override\` merge tags. Those tags only mean something *while*
# merging, and Portainer deploys a single file — so the merge is done here
# ahead of time.
#
# Secrets are NOT baked in: every \${VAR} is a placeholder, filled from
# Portainer's environment variables exactly as it would be from .env. The
# variables to set are listed in .env.example.
"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  config --no-interpolate > "$TMP"

# Paths back to relative, so the stack works from wherever it is checked out.
sed -i "s#: ${ROOT}/#: ./#g; s#: ${ROOT}\$#: .#g" "$TMP"

{ printf '%s\n' "$HEADER"; cat "$TMP"; } > "$OUT"

if grep -q "$ROOT" "$OUT"; then
  echo "ERROR: $OUT still contains host paths:" >&2
  grep -n "$ROOT" "$OUT" >&2
  exit 1
fi

echo "Wrote $OUT"
