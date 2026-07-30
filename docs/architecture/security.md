# Security Model

Implements spec §29 (Security) and §30/§34 hardening rules. UMG is an
internal system: **deployed on a LAN/VPN only, single admin, no internet
exposure by design** — but it is still hardened as if the LAN is hostile.

---

## 1. Access control (§29.1)

| Mechanism | Detail |
|---|---|
| Admin UI | Only from LAN/VPN, behind the nginx reverse proxy. |
| Admin identity | **Single local admin**; Argon2id password hash in `admin_users`. |
| Session | Server-side session stored in **Redis** (`umg:sess:` prefix), cookie `umg.session`: HttpOnly, SameSite=Strict, `Secure` when `SESSION_SECURE=true`. |
| Idle timeout | **12 hours** default (configurable), absolute cookie `maxAge` matches. |
| Login protection | Rate limiting; account lockout after repeated failures with timed release. |
| CSRF | State-changing admin routes require the session; SameSite=Strict cookie plus origin checks on the SPA API client. |
| API clients | **Global Bearer tokens** (`Authorization: Bearer …`); cryptographically secure generation; **only the hash stored** (`global_api_tokens.token_hash`); plaintext shown exactly once at generation; revocation is soft (`revoked_at`). |
| Privileged endpoints | `/health/details`, Swagger UI — admin session or LAN allowlist only. |
| 2FA | Deliberately absent in release 1.0. |

**First run (§29.2):** the admin is bootstrapped via one-time env
(`ADMIN_BOOTSTRAP_PASSWORD`) while the DB is empty, or via a setup wizard.
After creation the env password is ignored. The global API token is then
generated in the UI. The last admin account cannot be deleted. Telemetry is
disabled.

---

## 2. Secret storage (§29.3)

Encrypted at rest (never logged, never returned by the API):

- transport account credentials (`transport_accounts.encrypted_config`);
- webhook signing secrets;
- SMTP password;
- Telegram bot token;
- LLM API key;
- UnoAPI auth tokens;
- DBLtek vendor credentials.

Application-level envelope encryption key is supplied via environment /
Docker secret (`.env` with `0600` permissions; Docker secrets where
practical). API token storage is one-way (hash), not encryption. Session and
cookie secrets: `SESSION_SECRET`, `COOKIE_SECRET`, ≥32 random bytes. Signal
registration keys and UnoAPI sessions live on dedicated volumes and are part
of the mandatory backup set (§31).

---

## 3. Network isolation (§29.4, §30)

- **Host-exposed**: only the reverse proxy port (default `8083`). The UI,
  API and `/api/docs` are reachable exclusively through it.
- **UDP 44444** is exposed only in `goip_vendor_embedded`/native mode and
  only to the GoIP device IP.
- **Not exposed**: PostgreSQL, Redis, UnoAPI, signal-cli-rest-api, vendor
  SMS Server HTTP, adapter callback ingress routes. Docker networks are
  segmented into `frontend`, `backend` (internal), `transports` and `goip`;
  `backend` is `internal: true` in compose.
- The vendor (DBLtek) container is **not reachable from the LAN** and SHOULD
  have no internet egress; its legacy PHP/MySQL stack is isolated on its own
  network.
- Compose hardening: exact image tags, `restart: unless-stopped`,
  healthchecks, non-root users, read-only root filesystems where possible, no
  Docker socket mounts, log rotation, `TZ=Europe/Kyiv`.

---

## 4. SSRF policy for webhook destinations (§29.5)

Webhook URLs **may legitimately point into the LAN** (n8n, internal
bridges), so blanket-blocking private IPs is forbidden. Instead:

1. Admin-controlled **allowlist** of hosts/schemes.
2. Cloud metadata ranges always blocked (`169.254.169.254` et al.).
3. **DNS re-resolution check** immediately before connect (anti-rebinding).
4. Allowed schemes configurable, default `http`/`https`; never `file://`,
   `gopher://` or unix sockets.
5. Hard timeout and response body size limit.
6. Redirect policy configurable; default **no cross-host redirects**.

---

## 5. Audit (§29.6)

Every sensitive action writes an `AuditLog` row (actor, action, entity,
before/after JSON):

login/logout · password change · API token generate/revoke ·
channel/account/endpoint create/update/delete · routing rule changes ·
destination changes · alert rule changes · parser changes · retention
changes · manual retry/replay · manual USSD · **secret replacement without
saving plaintext** · admin acknowledge/resolve of an alert.

Audit records are append-only; there is no UI to edit or delete them.

---

## 6. Application hardening

- `helmet()` security headers on all API responses.
- Global validation pipe: `whitelist + forbidNonWhitelisted` (unknown JSON
  fields rejected), no implicit type coercion.
- Structured Pino logs with secret redaction; request/correlation ids on
  every entry (§32).
- Payload size limits; `413` on oversize.
- Dependency scanning and pinned base images in build pipelines (§34).

## 7. Data protection notes

- Canonical phone storage E.164; operator-entered raw values retained
  alongside for audit.
- Text messages retained indefinitely (ADR-015) — treat backups accordingly.
- Attachments on `umg-media-data` volume, access only via short-lived
  **signed URLs**, configurable retention, deletion audited and emitting
  `media.deleted`.
- Error responses never leak internals: common error envelope with
  `request_id` only (spec §14.4).
