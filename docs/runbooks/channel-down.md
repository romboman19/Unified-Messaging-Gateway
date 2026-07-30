# Runbook: Channel Down / Degraded

Trigger: alert `channel.disconnected` / `channel.degraded`, or an account
shows `degraded`/`disabled` in the UI, or outbound messages consistently
reach status `failed`.

## 1. Assess

1. UI → **Канали**: check the account status and which endpoints are
   affected.
2. UI → **Повідомлення**: open a few failed messages, read the adapter
   error in the attempts section.
3. Container state:

   ```bash
   docker compose ps
   docker compose logs --tail=200 umg-worker
   docker compose logs --tail=200 umg-api
   ```

4. Sidecar state (target channels):

   ```bash
   docker compose ps unoapi signal-api   # if enabled
   docker compose logs --tail=100 <sidecar>
   ```

## 2. Common causes and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED` / timeout in attempt errors | Sidecar down or network issue | `docker compose up -d <sidecar>`; verify `docker network inspect umg_transports` contains both API and sidecar |
| WhatsApp session invalid / QR required | UnoAPI session expired | Relink via WhatsApp reconnect (see `whatsapp-reconnect.md`); verify `umg-unoapi-data` volume intact |
| Signal send 4xx | Registration expired / key change | See `signal-relink.md`; verify `umg-signal-data` volume |
| GoIP SMS failing for all endpoints | Vendor SMS Server down or GoIP link lost | Check vendor container and GoIP device; see `goip-rollback.md` |
| Single endpoint failing, others fine | SIM/modem problem | Swap SIM, verify balance, re-enable endpoint in UI |
| 401/403 from sidecar | Rotated credentials | Update `encrypted_config` via UI (channel edit). Secret replacement is audit-logged without storing plaintext |

## 3. Contain

While the root cause is being fixed:

- Set the account status to `inactive` or disable affected endpoints in the
  UI to stop burning retry attempts (3 attempts per message, ADR-013 — a
  dead channel still consumes them and delays failure signals).
- There is **no automatic channel failover** (ADR-012): route urgent traffic
  by creating new messages on a healthy channel manually if needed.

## 4. Recover

1. Fix the cause, then re-enable the account/endpoint in the UI.
2. Verify with a single test message (`Idempotency-Key` must be new).
3. Bulk-check recent `failed` messages and resend the important ones with
   new sends (status history keeps the originals).
4. Acknowledge and resolve the alert in the UI (audited), confirming no
   same-type alert re-opens.

## 5. Escalation notes

- Repeated degradation of all endpoints on one account within 24 h → file a
  bug with adapter attempt errors attached.
- Never edit `encrypted_config` raw in the database; rotate via the UI.
