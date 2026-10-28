# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-10-28

### Fixed

- The Overview page's "Версія" card showed a hardcoded 0.1.0; it now shows
  the version the API reports.

## [0.3.0] - 2026-10-28

SMS over a real GoIP (DBLtek SMS Server in the stack), WhatsApp and Signal
end to end, security hardening, and reliable SMS threads.

### Added

- **SMS via GoIP** — DBLtek SMS Server runs in the stack; send, delivery
  reports, inbound SMS, on-demand and daily SIM balance checks over USSD.
- **WhatsApp (gwmd) and Signal** — QR pairing from the web wizard, inbound
  messages, files both ways.
- **Long SMS reassembly** — segments the GoIP forwards separately and out of
  order are buffered and stored as one message; text the gateway glued in
  arrival order (final segment in the middle) is put back in order
  (`SMS_CONCAT_QUIET_SECONDS`, `SMS_CONCAT_MAX_SECONDS`).
- **Version display** — the web panel shows its version and warns when the
  API runs a different one; `GET /api/v1/health/version`.
- Single-file Portainer stack; API reference on the API tab; file
  attachments in the test chat.

### Fixed

- SMS threads: one phone normaliser for both directions (national-format
  numbers split threads), unique thread per peer with a repair migration,
  GoIP time read in `Europe/Kyiv` (`DBSMS_TIMEZONE`) instead of UTC,
  same-second SMS no longer dropped as duplicates, thread view shows the
  latest messages, replies leave from the thread's own SIM.
- Worker could not reach webhook/SMTP/Telegram destinations (egress network).
- Deleting a destination with delivery history failed.

### Security

- DBLtek container hardened: no world-writable web root, schema dumps and
  daemon not servable, shell-exec PHP functions disabled, escaped
  credentials in generated config/SQL, secrets scrubbed from the PHP
  environment, vendor UI on loopback by default (`SMS_WEB_BIND`).
- `dbsms` webhook fails closed without its secret; vendor webhooks are no
  longer reachable through the reverse proxy.
- Audit log redacts credentials.

## [0.2.0] - 2026-07-30

Milestone 1: routing, webhook deliveries, attachments, alerts, documentation set.

### Added

- **Routing engine** — routing rules filtering canonical events by event
  type, channel type, transport account, endpoint, direction and severity;
  one event fans out to multiple destinations (spec §15).
- **Webhook destinations** — CRUD for `webhook`, `email`, `telegram` and
  `internal_log` destinations; test delivery action; secrets encrypted at
  rest and never returned by the API.
- **Webhook deliveries** — delivery log with HMAC-SHA256 request signing
  (`X-UMG-Event-Id`, `X-UMG-Timestamp`, `X-UMG-Attempt`,
  `X-UMG-Signature`), retry schedule 0/60/300/900/3600 s, DLQ
  (`dead_lettered`) after 5 failures with alert, and manual replay creating
  a new delivery with the same event id (spec §15.4–15.5).
- **Attachments** — local media storage on the `umg-media-data` volume,
  short-lived signed download URLs, configurable retention with audited
  deletion (`media.deleted` event) (ADR-015).
- **Alerts** — stateful incidents (`open`/`acknowledged`/`resolved`) for
  channel degradation, webhook dead-lettering, queue backlog and storage
  pressure; dedup prevents notification storms (spec §18).
- **UI** — new pages for routing rules, destinations, deliveries/DLQ,
  alerts and attachments (Ukrainian interface).
- **Documentation set** per spec §41:
  - `docs/api/openapi.yaml` — OpenAPI 3.0 for the live API plus [Planned]
    endpoints;
  - `docs/architecture/` — overview, adapters, data model, security;
  - `docs/operator-guide/uk.md` — Ukrainian operator guide;
  - `docs/runbooks/` — backup/restore, channel-down, queue-recovery, plus
    goip-rollback / signal-relink / whatsapp-reconnect stubs;
  - `docs/licensing/third-party.md` — GPL/MIT/vendor licensing notes.

### Changed

- `README.md` — added documentation index; roadmap updated for
  Milestone 1 completion.

## [0.1.0] - 2026-07-28

Milestone 0: working skeleton.

### Added

- **Auth** — single local admin (Argon2id), Redis-backed sessions,
  HttpOnly SameSite=Strict cookie, 12 h idle timeout; bootstrap via
  `ADMIN_BOOTSTRAP_PASSWORD`.
- **Global API tokens** — generate/list/revoke in UI, hash-only storage,
  Bearer auth for API clients.
- **Channels** — transport accounts and endpoints CRUD via UI
  (`/channels`) and REST API; secrets in `encrypted_config`.
- **Messages** — send via mock adapter with `Idempotency-Key` support
  (7-day retention), list and detail with attempts and status history.
- **BullMQ worker** — outbound send pipeline with 3 attempts at 0/60/60 s
  (ADR-013), full `MessageStatusHistory` for every transition.
- **Audit log** — login, token and channel changes recorded
  (`AuditLog`).
- **Infrastructure** — Docker Compose deployment (nginx reverse proxy,
  web, api, worker, PostgreSQL 17, Redis 8), health endpoints
  (`/health/live`, `/health/ready`, `/health/details`), smoke test and
  E2E channels test.
