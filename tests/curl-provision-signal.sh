#!/usr/bin/env bash
# End-to-end verification of the QR provisioning flow (TZ §1038).
#
# Pre-conditions:
#   - docker compose stack is up (api, web, postgres, signal-cli-stub)
#   - ADMIN_BOOTSTRAP_PASSWORD is in `.env` on the server
#
# What this proves:
#   1. We can mint a QR via the API
#   2. The stub-side `/v1/_stub/link` hook simulates a phone scan
#   3. Polling detects the linked device and flips the endpoint to `linked`
#   4. The endpoint row carries the new uuid / phoneE164
#   5. `DELETE /endpoints/<id>/registration` cleanly unlinks
#
# Run on the dev server:
#   base=http://localhost:8083
#   set -a; . ./.env; set +a
#   bash tests/curl-provision-signal.sh
set -euo pipefail

if [[ -z "${BASE:-}" ]]; then
  echo "Set BASE first (e.g. export BASE=http://localhost:8083)" >&2
  exit 1
fi

echo "── 1. Login ──"
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT
curl -sS -c "$COOKIE" -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"password\":\"${ADMIN_BOOTSTRAP_PASSWORD:?}\"}" > /dev/null

echo "── 2. Find Signal transport account ──"
ACCT_ID=$(curl -sS -b "$COOKIE" "$BASE/api/v1/transport-accounts" \
  | python3 -c 'import sys,json; print([a["id"] for a in json.load(sys.stdin) if a["adapter"]=="signal-cli-rest-api"][0])')
echo "  accountId=$ACCT_ID"

echo "── 3. Request QR ──"
DEVICE_NAME="umg-e2e-$(date +%s)"
RES=$(curl -sS -b "$COOKIE" -X POST "$BASE/api/v1/transport-accounts/$ACCT_ID/provision/qrcode" \
  -H 'content-type: application/json' \
  -d "{\"label\":\"E2E signal\",\"deviceName\":\"$DEVICE_NAME\"}")
echo "  response: $RES"
EP_ID=$(echo "$RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["endpointId"])')
URI=$(echo "$RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["uri"])')

echo "── 4. Verify URI shape ──"
if [[ ! "$URI" =~ ^signalcaptcha:// ]]; then
  echo "FAIL: URI shape wrong: $URI" >&2
  exit 1
fi
echo "  OK — $URI"

echo "── 5. Simulate phone scan via dev-only stub hook ──"
curl -sS -X POST "http://localhost:8080/v1/_stub/link" \
  -H 'content-type: application/json' \
  -d "{\"deviceName\":\"$DEVICE_NAME\"}"
echo

echo "── 6. Poll until linked ──"
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

echo "── 7. Verify endpoint row carries uuid + phoneE164 ──"
curl -sS -b "$COOKIE" "$BASE/api/v1/transport-accounts" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
ep = [e for a in d for e in a['endpoints'] if e['id']=='$EP_ID'][0]
assert ep['registrationState']=='linked', ep
assert ep['phoneE164'], ep
assert ep['uuid'], ep
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
assert ep['uuid'] is None, ep
assert ep['phoneE164'] is None, ep
print('  OK — endpoint reset:', ep['registrationState'])
"

echo "── PASS ──"
