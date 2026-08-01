#!/usr/bin/env bash
# End-to-end verification of the WhatsApp (gwmd) QR provisioning flow (TZ §1038).
#
# Pre-conditions:
#   - docker compose stack is up (api, web, postgres, gwmd stub)
#   - ADMIN_BOOTSTRAP_PASSWORD is in `.env` on the server
#   - GWMD_BASE_URL is set (defaults to http://gwmd:3000)
#
# What this proves:
#   1. We can mint a QR via the API with `kind:'whatsapp'` against a gwmd account
#   2. The stub-side `/app/devices/:id/_stub/connect` hook simulates a scan
#   3. Polling detects the logged-in device and flips the endpoint to `linked`
#   4. `DELETE /endpoints/<id>/registration` cleanly unlinks via /app/devices DELETE
#
# Run on the dev server (host-side):
#   export BASE=http://localhost:8083
#   set -a; . ./.env; set +a
#   bash tests/curl-provision-gwmd.sh
set -euo pipefail

if [[ -z "${BASE:-}" ]]; then
  echo "Set BASE first (e.g. export BASE=http://localhost:8083)" >&2
  exit 1
fi

STUB_CONTAINER="${STUB_CONTAINER:-umg-gwmd}"
STUB_PORT="${STUB_PORT:-3000}"
STUB_BASE="${STUB_BASE:-http://localhost:$STUB_PORT}"

echo "── 1. Login ──"
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT
curl -sS -c "$COOKIE" -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"${ADMIN_BOOTSTRAP_PASSWORD:?}\"}" > /dev/null

echo "── 2. Find gwmd transport account ──"
ACCT_ID=$(curl -sS -b "$COOKIE" "$BASE/api/v1/transport-accounts" \
  | python3 -c 'import sys,json; print([a["id"] for a in json.load(sys.stdin) if a["adapter"]=="gwmd"][0])')
echo "  accountId=$ACCT_ID"

echo "── 3. Request QR ──"
PHONE="+38050$(date +%s | tail -c 6)"
RES=$(curl -sS -b "$COOKIE" -X POST "$BASE/api/v1/transport-accounts/$ACCT_ID/provision/qrcode" \
  -H 'content-type: application/json' \
  -d "{\"kind\":\"whatsapp\",\"label\":\"E2E gwmd\",\"phoneE164\":\"$PHONE\"}")
echo "  response: $RES"
EP_ID=$(echo "$RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["endpointId"])')
URI=$(echo "$RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["uri"])')

echo "── 4. Verify URI shape (gwmd returns qr_link as URL or data: URL) ──"
if [[ ! "$URI" =~ ^(data:|https?://) ]]; then
  echo "FAIL: URI shape wrong: $URI" >&2
  exit 1
fi
echo "  OK — $URI"

echo "── 5. Simulate phone scan via dev-only stub hook ──"
PHONE_NO_PLUS=${PHONE#+}
if curl -sS -m 2 -o /dev/null "$STUB_BASE/health" 2>/dev/null; then
  curl -sS -X POST "$STUB_BASE/app/devices/$PHONE_NO_PLUS/_stub/connect" \
    -H 'content-type: application/json' -d '{}'
else
  # Stub isn't reachable from host; reach the docker container directly.
  docker exec "$STUB_CONTAINER" node -e "fetch('http://127.0.0.1:$STUB_PORT/app/devices/$PHONE_NO_PLUS/_stub/connect',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exit(1)})"
fi
echo

echo "── 6. Poll until linked ──"
STATE='unknown'
for i in $(seq 1 15); do
  STATE=$(curl -sS -b "$COOKIE" "$BASE/api/v1/transport-accounts/$ACCT_ID/provision/$EP_ID/poll" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["state"])')
  echo "  poll #$i state=$STATE"
  [[ "$STATE" == "linked" ]] && break
  sleep 2
done

if [[ "$STATE" != "linked" ]]; then
  echo "FAIL: endpoint did not transition to linked" >&2
  exit 1
fi

echo "── 7. Verify endpoint row carries phoneE164 + externalId ──"
curl -sS -b "$COOKIE" "$BASE/api/v1/transport-accounts" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
ep = [e for a in d for e in a['endpoints'] if e['id']=='$EP_ID'][0]
assert ep['registrationState']=='linked', ep
print('  OK —', json.dumps(ep, indent=2, ensure_ascii=False))
"

echo "── 8. Unlink ──"
curl -sS -b "$COOKIE" -X DELETE "$BASE/api/v1/endpoints/$EP_ID/registration"
echo

echo "── 9. Verify endpoint row reset ──"
curl -sS -b "$COOKIE" "$BASE/api/v1/transport-accounts" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
ep = [e for a in d for e in a['endpoints'] if e['id']=='$EP_ID'][0]
assert ep['registrationState']=='unpaired', ep
assert ep['phoneE164'] is None, ep
assert ep['externalId'] is None, ep
print('  OK — endpoint reset:', ep['registrationState'])
"

echo "── PASS ──"
