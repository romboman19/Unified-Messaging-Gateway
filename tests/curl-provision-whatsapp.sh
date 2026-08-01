#!/usr/bin/env bash
# End-to-end verification of the WhatsApp (UnoAPI) QR provisioning flow (TZ §1038).
#
# Pre-conditions:
#   - docker compose stack is up (api, web, postgres, unoapi stub)
#   - ADMIN_BOOTSTRAP_PASSWORD is in `.env` on the server
#   - STUB_BASE must be reachable. Easiest: run via a one-shot curl container
#     on the `transports` network:
#       docker run --rm --network umg_transports curlimages/curl:latest \
#         -c "set -a; . ./.env; set +a; BASE=http://umg-api:4000 STUB_BASE=http://unoapi:9876 bash /tests/curl-provision-whatsapp.sh"
#     (then the cookies file needs to be ignored — see below).
#
# What this proves:
#   1. We can mint a QR via the API with `kind:'whatsapp'` and a phoneE164
#   2. The stub-side `/session/:phone/_stub/connect` hook simulates a scan
#   3. Polling detects the connected session and flips the endpoint to `linked`
#   4. `DELETE /endpoints/<id>/registration` cleanly unlinks
#
# Run on the dev server (host-side):
#   export BASE=http://localhost:8083
#   export STUB_BASE=http://localhost:9876   # only if UnoAPI stub is host-published
#   set -a; . ./.env; set +a
#   bash tests/curl-provision-whatsapp.sh
set -euo pipefail

if [[ -z "${BASE:-}" ]]; then
  echo "Set BASE first (e.g. export BASE=http://localhost:8083)" >&2
  exit 1
fi

STUB_BASE="${STUB_BASE:-http://unoapi:9876}"

echo "── 1. Login ──"
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT
curl -sS -c "$COOKIE" -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"password\":\"${ADMIN_BOOTSTRAP_PASSWORD:?}\"}" > /dev/null

echo "── 2. Find WhatsApp transport account ──"
ACCT_ID=$(curl -sS -b "$COOKIE" "$BASE/api/v1/transport-accounts" \
  | python3 -c 'import sys,json; print([a["id"] for a in json.load(sys.stdin) if a["adapter"]=="unoapi"][0])')
echo "  accountId=$ACCT_ID"

echo "── 3. Request QR ──"
PHONE="+1000000$(date +%s | tail -c 5)"
RES=$(curl -sS -b "$COOKIE" -X POST "$BASE/api/v1/transport-accounts/$ACCT_ID/provision/qrcode" \
  -H 'content-type: application/json' \
  -d "{\"kind\":\"whatsapp\",\"label\":\"E2E whatsapp\",\"phoneE164\":\"$PHONE\"}")
echo "  response: $RES"
EP_ID=$(echo "$RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["endpointId"])')
URI=$(echo "$RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["uri"])')

echo "── 4. Verify URI shape ──"
if [[ ! "$URI" =~ ^waqr:// ]]; then
  echo "FAIL: URI shape wrong: $URI" >&2
  exit 1
fi
echo "  OK — $URI"

echo "── 5. Simulate phone scan via dev-only stub hook ──"
PHONE_NO_PLUS=${PHONE#+}
curl -sS -X POST "$STUB_BASE/session/$PHONE_NO_PLUS/_stub/connect"
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
assert ep['phoneE164']=='$PHONE', ep
assert ep['externalId']=='$PHONE_NO_PLUS', ep
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