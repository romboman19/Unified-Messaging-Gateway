#!/usr/bin/env python3
import base64
import json
import os
import subprocess
import sys
import time

BASE = "http://127.0.0.1:8083"
ADMIN_PASSWORD = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD", "")
COOKIE_JAR = "/tmp/umg-smoke-cookies.txt"
TOKEN_FILE = "/tmp/umg-smoke-token.txt"
SINK_NAME = "umg-hook-sink"
SINK_NETWORK = "umg_backend"


def curl(*args, decode=True):
    cmd = ["curl", "-s", "-c", COOKIE_JAR, "-b", COOKIE_JAR] + list(args)
    out = subprocess.check_output(cmd)
    return out.decode() if decode else out


def api(method, path, payload=None, token=None):
    args = ["-X", method, f"{BASE}{path}", "-H", "Content-Type: application/json"]
    if token:
        args += ["-H", f"Authorization: Bearer {token}"]
    if payload is not None:
        args += ["-d", json.dumps(payload)]
    return json.loads(curl(*args))


def session_api(method, path, payload=None):
    """Call a session-only endpoint using the admin cookie jar."""
    args = ["-X", method, f"{BASE}{path}", "-H", "Content-Type: application/json"]
    if payload is not None:
        args += ["-d", json.dumps(payload)]
    return json.loads(curl(*args))


def docker(*args):
    return subprocess.check_output(["docker"] + list(args)).decode()


def step(name):
    print(f"{name} ...", end=" ")
    sys.stdout.flush()


def ok():
    print("OK")


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def wait_for_delivery(destination_id, wanted_status, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = session_api("GET", f"/api/v1/deliveries?destinationId={destination_id}&limit=10")
        for d in data.get("items", []):
            if d.get("status") == wanted_status:
                return d
        time.sleep(1)
    return None


def cleanup_sink():
    try:
        subprocess.run(
            ["docker", "rm", "-f", SINK_NAME],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except Exception:
        pass


try:
    # Clean state.
    cleanup_sink()

    step("1. web root")
    status = curl("-o", "/dev/null", "-w", "%{http_code}", f"{BASE}/")
    if status.strip() != "200":
        fail(f"web root returned {status}")
    ok()

    step("2. admin login")
    r = curl(
        "-X",
        "POST",
        f"{BASE}/api/v1/auth/login",
        "-H",
        "Content-Type: application/json",
        "-d",
        json.dumps({"username": "admin", "password": ADMIN_PASSWORD}),
    )
    if '"user"' not in r:
        fail(r)
    ok()

    step("3. create API token")
    r = curl(
        "-X",
        "POST",
        f"{BASE}/api/v1/api-tokens",
        "-H",
        "Content-Type: application/json",
        "-d",
        json.dumps({"name": "smoke"}),
    )
    data = json.loads(r)
    token = data.get("token", "")
    if not token.startswith("umg_"):
        fail(r)
    ok()

    step("4. create transport account")
    account = api(
        "POST",
        "/api/v1/transport-accounts",
        {
            "type": "mock",
            "adapter": "mock",
            "name": "Smoke mock account",
            "status": "active",
            "config": {},
        },
    )
    account_id = account.get("id")
    if not account_id:
        fail(json.dumps(account))
    ok()

    step("5. create endpoint")
    endpoint = api(
        "POST",
        f"/api/v1/transport-accounts/{account_id}/endpoints",
        {
            "label": "Smoke endpoint",
            "externalId": "smoke-1",
            "phoneE164": "+380991234567",
            "enabled": True,
            "config": {},
        },
    )
    endpoint_id = endpoint.get("id")
    if not endpoint_id:
        fail(json.dumps(endpoint))
    ok()

    step("6. send mock message")
    msg = api(
        "POST",
        "/api/v1/messages",
        {
            "channel": "mock",
            "to": "+380991234567",
            "type": "text",
            "content": {"text": "Smoke test"},
            "accountId": account_id,
            "endpointId": endpoint_id,
        },
        token=token,
    )
    if msg.get("status") != "queued":
        fail(json.dumps(msg))
    msg_id = msg["id"]
    ok()

    step("7. wait for delivery")
    for _ in range(20):
        data = api("GET", f"/api/v1/messages/{msg_id}", token=token)
        if data.get("status") == "sent":
            ok()
            break
        time.sleep(1)
    else:
        fail(f"status={data.get('status')}")

    step("8. start webhook sink container")
    docker(
        "run",
        "--rm",
        "-d",
        "--network",
        SINK_NETWORK,
        "--name",
        SINK_NAME,
        "hashicorp/http-echo",
        "-listen=:5678",
        "-text=ok",
    )
    # Give the sink a moment to start accepting connections.
    time.sleep(2)
    ok()

    step("9. create webhook destination and routing rule")
    destination = session_api(
        "POST",
        "/api/v1/destinations",
        {
            "name": "Smoke webhook sink",
            "type": "webhook",
            "enabled": True,
            "url": f"http://{SINK_NAME}:5678/",
            "secret": "smoke-secret",
            "timeoutMs": 10000,
        },
    )
    destination_id = destination.get("id")
    if not destination_id:
        fail(json.dumps(destination))

    rule = session_api(
        "POST",
        "/api/v1/routing-rules",
        {
            "name": "Smoke routing rule",
            "priority": 10,
            "eventTypes": [
                "message.queued",
                "message.sent",
                "message.delivered",
            ],
            "filters": {},
            "fieldSelector": [],
            "destinationIds": [destination_id],
        },
    )
    if not rule.get("id"):
        fail(json.dumps(rule))
    ok()

    step("10. send mock and wait for webhook delivery delivered")
    routed_msg = api(
        "POST",
        "/api/v1/messages",
        {
            "channel": "mock",
            "to": "+380991234567",
            "type": "text",
            "content": {"text": "Routed smoke test"},
            "accountId": account_id,
            "endpointId": endpoint_id,
        },
        token=token,
    )
    if routed_msg.get("status") != "queued":
        fail(json.dumps(routed_msg))
    delivered = wait_for_delivery(destination_id, "delivered", timeout=30)
    if not delivered:
        fail("webhook delivery did not reach delivered status in time")
    ok()

    step("11. destination with bad URL fails permanently (4xx)")
    bad_destination = session_api(
        "POST",
        "/api/v1/destinations",
        {
            "name": "Smoke bad URL",
            "type": "webhook",
            "enabled": True,
            "url": "http://umg-api:4000/no-such-route",
            "timeoutMs": 5000,
        },
    )
    bad_id = bad_destination.get("id")
    if not bad_id:
        fail(json.dumps(bad_destination))
    bad_test = session_api("POST", f"/api/v1/destinations/{bad_id}/test", {})
    if bad_test.get("status") != "failed":
        fail(f"expected permanent failure, got {bad_test}")
    if (bad_test.get("responseCode") or 0) < 400:
        fail(f"expected 4xx response code, got {bad_test}")
    bad_delivery_id = bad_test.get("deliveryId")
    bad_delivery = session_api("GET", f"/api/v1/deliveries/{bad_delivery_id}")
    bad_event_id = bad_delivery.get("eventId")
    ok()

    step("12. POST /destinations/:id/test returns delivered")
    good_test = session_api("POST", f"/api/v1/destinations/{destination_id}/test", {})
    if good_test.get("status") != "delivered":
        fail(f"expected delivered test, got {good_test}")
    ok()

    step("13. POST /deliveries/:id/replay creates new delivery with same eventId")
    if not bad_delivery_id:
        fail("missing bad delivery id for replay")
    replay = session_api("POST", f"/api/v1/deliveries/{bad_delivery_id}/replay", {})
    if replay.get("id") == bad_delivery_id:
        fail("replay did not create a new delivery id")
    replay_event_id = replay.get("eventId") or replay.get("event", {}).get("id")
    if replay_event_id != bad_event_id:
        fail(f"replay eventId mismatch: {replay}")
    if replay.get("status") not in ("pending", "delivering", "delivered", "failed"):
        fail(f"unexpected replay status: {replay}")
    ok()

    step("14. media upload (JSON base64), download, signed URL")
    payload_bytes = b"UMG smoke test media payload"
    media_payload = {
        "fileName": "smoke.txt",
        "mimeType": "text/plain",
        "dataBase64": base64.b64encode(payload_bytes).decode("ascii"),
    }
    uploaded = session_api("POST", "/api/v1/media", media_payload)
    media_id = uploaded.get("id")
    if not media_id:
        fail(json.dumps(uploaded))

    downloaded = curl(f"{BASE}/api/v1/media/{media_id}", decode=False)
    if downloaded != payload_bytes:
        fail("downloaded media bytes do not match uploaded bytes")

    signed = session_api("GET", f"/api/v1/media/{media_id}/signed-url")
    signed_url = signed.get("url")
    if not signed_url:
        fail(json.dumps(signed))
    signed_body = curl(f"{BASE}{signed_url}", decode=False)
    if signed_body != payload_bytes:
        fail("signed URL media bytes do not match uploaded bytes")
    ok()

    step("15. GET /events contains message.queued")
    events = session_api("GET", "/api/v1/events?limit=100")
    if not any(ev.get("eventType") == "message.queued" for ev in events.get("items", [])):
        fail("no message.queued event found")
    ok()

    step("16. GET /audit-logs is not empty")
    audit = session_api("GET", "/api/v1/audit-logs?limit=10")
    if not audit.get("items"):
        fail("audit logs are empty")
    ok()

    print("ALL SMOKE TESTS PASSED")
    sys.exit(0)
except subprocess.CalledProcessError as e:
    fail(f"command failed: {e.cmd}\n{e.output.decode() if e.output else ''}")
except Exception as e:
    fail(str(e))
finally:
    cleanup_sink()
