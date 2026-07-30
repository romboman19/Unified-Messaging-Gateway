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
    login_payload = json.dumps({"username": "admin", "password": ADMIN_PASSWORD})
    r = curl("-X", "POST", f"{BASE}/api/v1/auth/login",
             "-H", "Content-Type: application/json",
             "-d", login_payload)
    if '"user"' not in r:
        fail(r)
    ok()

    step("3. create API token")
    r = curl("-X", "POST", f"{BASE}/api/v1/api-tokens",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"name": "smoke"}))
    data = json.loads(r)
    token = data.get("token", "")
    if not token.startswith("umg_"):
        fail(r)
    ok()

    step("4. send mock message")
    msg_payload = json.dumps({
        "channel": "mock",
        "to": "+380991234567",
        "type": "text",
        "content": {"body": "Smoke test"}
    })
    r = curl("-X", "POST", f"{BASE}/api/v1/messages",
             "-H", f"Authorization: Bearer {token}",
             "-H", "Content-Type: application/json",
             "-d", msg_payload)
    data = json.loads(r)
    if data.get("status") != "queued":
        fail(r)
    msg_id = data["id"]
    ok()

    step("5. wait for delivery")
    for _ in range(20):
        r = curl("-X", "GET", f"{BASE}/api/v1/messages/{msg_id}",
                 "-H", f"Authorization: Bearer {token}")
        data = json.loads(r)
        if data.get("status") == "sent":
            ok()
            sys.exit(0)
        time.sleep(1)
    fail(f"status={data.get('status')}")
except Exception as e:
    fail(str(e))
