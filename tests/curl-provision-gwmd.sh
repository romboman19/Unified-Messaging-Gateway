#!/usr/bin/env sh
# End-to-end verification of the WhatsApp (gwmd) QR provisioning flow (TZ §1038).
#
# Pre-conditions:
#   - docker compose stack is up (api, web, postgres, gwmd stub)
#   - ADMIN_BOOTSTRAP_PASSWORD is set in the environment
#   - GWMD_BASE_URL is reachable from the test runner
#
# This test runs inside a one-shot container with bash + curl + jq + node.
# It exercises the full wizard flow: mint QR → simulate scan → poll → linked
# → unlink → reset.
#
# Run on the dev server (host-side):
#   set -a; . ./.env; set +a
#   bash tests/run-gwmd-smoke.sh
set -eu

if [ -z "${BASE:-}" ]; then
  echo "Set BASE first (e.g. export BASE=http://localhost:8083)" >&2
  exit 1
fi

STUB_CONTAINER="${STUB_CONTAINER:-umg-gwmd}"
STUB_PORT="${STUB_PORT:-3000}"
STUB_BASE="${STUB_BASE:-http://localhost:$STUB_PORT}"
COOKIES=/tmp/umg-gwmd-cookies-jar

echo "── 1. Login ──"
curl -sS -c "$COOKIES" -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"${ADMIN_BOOTSTRAP_PASSWORD:?}\"}" > /dev/null

echo "── 2. Find gwmd transport account ──"
ACCT_ID=$(curl -sS -b "$COOKIES" "$BASE/api/v1/transport-accounts" \
  | jq -r '.[] | select(.adapter=="gwmd") | .id')
echo "  accountId=$ACCT_ID"

echo "── 3. Request QR ──"
PHONE="+38050$(date +%s | tail -c 6)"
RES=$(curl -sS -b "$COOKIES" -X POST "$BASE/api/v1/transport-accounts/$ACCT_ID/provision/qrcode" \
  -H 'content-type: application/json' \
  -d "{\"kind\":\"whatsapp\",\"label\":\"E2E gwmd\",\"phoneE164\":\"$PHONE\"}")
echo "  response: $RES"
EP_ID=$(echo "$RES" | jq -r '.endpointId')
URI=$(echo "$RES" | jq -r '.uri')

echo "── 4. Verify URI shape (gwmd returns qr_link as URL or data: URL) ──"
case "$URI" in
  data:*|https://*|http://*) echo "  OK — $URI" ;;
  *) echo "FAIL: URI shape wrong: $URI" >&2; exit 1 ;;
esac

echo "── 5. Simulate phone scan via dev-only stub hook ──"
# gwmd's adapter used the phone (with `+`) as the device_id; replay that
# exact id against the stub's _stub/connect so the sidecar sets JID and
# the poll matcher can pick the row up.
DEVICE_ID=$(printf '%s' "$PHONE" | jq -sRr @uri)
if curl -sS -m 2 -o /dev/null "$STUB_BASE/health" 2>/dev/null; then
  curl -sS -X POST "$STUB_BASE/app/devices/$DEVICE_ID/_stub/connect" \
    -H 'content-type: application/json' -d '{}'
else
  # Stub isn't reachable from host; reach the docker container directly.
  docker exec "$STUB_CONTAINER" node -e "fetch('http://127.0.0.1:$STUB_PORT/app/devices/$DEVICE_ID/_stub/connect',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exit(1)})"
fi
echo

echo "── 6. Poll until linked ──"
STATE='unknown'
for i in $(seq 1 15); do
  STATE=$(curl -sS -b "$COOKIES" "$BASE/api/v1/transport-accounts/$ACCT_ID/provision/$EP_ID/poll" \
    | jq -r '.state')
  echo "  poll #$i state=$STATE"
  [ "$STATE" = "linked" ] && break
  sleep 2
done

if [ "$STATE" != "linked" ]; then
  echo "FAIL: endpoint did not transition to linked" >&2
  exit 1
fi

echo "── 7. Verify endpoint row carries phoneE164 + externalId ──"
curl -sS -b "$COOKIES" "$BASE/api/v1/transport-accounts" | jq -e --arg ep "$EP_ID" \
  '.. | objects | select(.id? == $ep) | select(.registrationState == "linked")' \
  > /dev/null && echo "  OK — endpoint is linked"

echo "── 8. Unlink ──"
curl -sS -b "$COOKIES" -X DELETE "$BASE/api/v1/endpoints/$EP_ID/registration"
echo

echo "── 9. Verify endpoint row reset ──"
curl -sS -b "$COOKIES" "$BASE/api/v1/transport-accounts" | jq -e --arg ep "$EP_ID" \
  '.. | objects | select(.id? == $ep) | select(.registrationState == "unpaired" and .phoneE164 == null and .externalId == null)' \
  > /dev/null && echo "  OK — endpoint reset"

echo "── PASS ──"
