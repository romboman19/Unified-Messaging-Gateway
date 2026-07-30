#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time

BASE = "http://127.0.0.1:8083"
ADMIN_PASSWORD = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD", "")
COOKIE_JAR = "/tmp/umg-smoke-cookies.txt"
TOKEN_FILE = "/tmp/umg-smoke-token.txt"


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


def step(name):
    print(f"{name} ...", end=" ")
    sys.stdout.flush()


def ok():
    print("OK")


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


try:
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
            "content": {"body": "Smoke test"},
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
            print("ALL SMOKE TESTS PASSED")
            sys.exit(0)
        time.sleep(1)
    fail(f"status={data.get('status')}")
except Exception as e:
    fail(str(e))
