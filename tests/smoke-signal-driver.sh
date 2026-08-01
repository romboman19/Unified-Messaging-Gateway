#!/usr/bin/env bash
# Wrapper that runs the smoke test on the VM with .env loaded.
set -euo pipefail
cd /srv/umg
set -a
. ./.env
set +a
export BASE="${BASE:-http://localhost:8083}"
export STUB_BASE="${STUB_BASE:-http://localhost:8080}"

LOGIN_BODY=$(printf '{"username":"%s","password":"%s"}' "admin" "$ADMIN_BOOTSTRAP_PASSWORD")

rm -f /tmp/umg-cookie.txt /tmp/umg-login.json /tmp/umg-login.headers
curl -sS -D /tmp/umg-login.headers -c /tmp/umg-cookie.txt \
  -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "$LOGIN_BODY" \
  -o /tmp/umg-login.json
STATUS=$(head -n1 /tmp/umg-login.headers | tr -d '\r' | awk '{print $2}')
echo "login HTTP $STATUS"
echo "  body: $(head -c 200 /tmp/umg-login.json)"

if [[ "$STATUS" != "200" ]]; then
  echo "FAIL: login did not return 200 — aborting smoke" >&2
  rm -f /tmp/umg-cookie.txt /tmp/umg-login.json /tmp/umg-login.headers
  exit 1
fi

rm -f /tmp/umg-login.json /tmp/umg-login.headers
exec bash tests/curl-provision-signal.sh
rm -f /tmp/umg-cookie.txt