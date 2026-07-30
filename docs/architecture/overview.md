# UMG Architecture Overview

**Unified Messaging Gateway (UMG)** is an internal, LAN-hosted single gateway
for SMS (GoIP/DBLtek), WhatsApp (UnoAPI) and Signal (signal-cli-rest-api).
This document describes the target architecture of release 1.0 and maps the
current Milestone 0/1 implementation onto it.

Primary requirements source: `docs/ТЗ.md`.

---

## 1. Architectural style: modular monolith + worker

ADR-001: the system is a **modular monolith** with a **separate worker
process**, not a set of microservices. Own UMG code consists of:

| Component | Tech | Role |
|---|---|---|
| `apps/web` | React 18 + Vite, Ukrainian UI | Admin SPA behind reverse proxy |
| `apps/api` | NestJS 10, TypeScript strict | Single REST API `/api/v1`, session + Bearer auth |
| `apps/worker` | Node 24, BullMQ | Async send/retry, webhook delivery, scheduled jobs |
| `packages/contracts` | TypeScript | Shared DTOs and canonical event model |
| `packages/database` | Prisma + PostgreSQL 17 | Single ORM, schema and migrations |
| `packages/channel-sdk` + `packages/adapter-*` | TypeScript | Adapter contract and transport adapters (see `adapters.md`) |

`api` and `worker` are built from the same monorepo and base image but run
with different commands.

External transport software (**UnoAPI, signal-cli-rest-api, DBLtek SMS
Server**) is **not embedded** into the core (ADR-002); it runs as separate
containers/sidecars on a private Docker network, reachable only over internal
HTTP/webhook.

---

## 2. Target deployment topology

```text
Admin ──LAN──▶ Reverse proxy / Web UI
API clients ──Bearer token──▶ Reverse proxy

Reverse proxy ──▶ UMG Web
Reverse proxy ──▶ UMG API
API    <──▶ PostgreSQL          API    <──▶ Redis
Worker <──▶ PostgreSQL          Worker <──▶ Redis
API    <──▶ Local media storage Worker <──▶ Local media storage

API <──private HTTP/webhook──▶ UnoAPI
API <──private HTTP/webhook──▶ signal-cli-rest-api
API <──private HTTP/JSON─────▶ DBLtek SMS Server
GoIP-4 / 4 SIM ──UDP 44444──▶ DBLtek SMS Server

Worker ──▶ Generic webhook / n8n
Worker ──▶ SMTP
Worker ──▶ Telegram
```

Docker compose services (target): `reverse-proxy`, `umg-web`, `umg-api`,
`umg-worker`, `postgres`, `redis`, `unoapi`, `signal-api`, `goip-vendor`
(optional profile). Networks: `frontend`, `backend`, `transports`, `goip`.
Only the reverse proxy port is exposed to the LAN; PostgreSQL, Redis and all
transport services are internal (see `security.md`).

---

## 3. Core modules

### 3.1 API application (`apps/api`)

- **Auth** — single local admin, Redis-backed sessions (HttpOnly,
  SameSite=Strict cookie, 12 h idle timeout), Argon2id password hash.
- **API tokens** — global Bearer tokens, hash stored in DB, plaintext shown
  once at generation.
- **Transport accounts / endpoints** — channels CRUD with adapter-specific
  config (secrets encrypted at rest).
- **Messages** — send (with idempotency), list, detail with attempts and
  status history.
- **Routing & destinations** _(Milestone 1, landing)_ — routing rule CRUD,
  webhook/email/telegram/internal_log destinations, test delivery.
- **Deliveries** _(landing)_ — webhook delivery log, DLQ, manual replay.
- **Attachments** _(landing)_ — local media storage with signed URLs and
  retention.
- **Alerts** _(landing)_ — alert list and acknowledgement.
- **Health** — `/health/live`, `/health/ready`, `/health/details`.
- **Audit log** — all administrative and sensitive actions recorded
  (`AuditLog`).

### 3.2 Worker application (`apps/worker`)

- **Send pipeline** — Dequeues outbound messages, invokes the channel
  adapter, writes attempts and status history. Retry: **3 attempts** —
  immediately, +60 s, +60 s (ADR-013). No automatic channel failover
  (ADR-012).
- **Event fan-out** — Drains the transactional `EventOutbox`, emits the
  canonical CloudEvents-compatible envelope (spec §15.3).
- **Routing engine** — Matches events against routing rules (filter by event
  type, channel type, account, endpoint, direction, severity) and expands
  each match into destination deliveries.
- **Webhook delivery** — POSTs signed webhooks.
  Signature: `X-UMG-Signature: sha256=<hex>`,
  `HMAC-SHA256(secret, timestamp + "." + raw_body)`, with
  `X-UMG-Event-Id`, `X-UMG-Timestamp`, `X-UMG-Attempt` headers.
  Retry schedule **0 / 60 / 300 / 900 / 3600 s** (5 attempts). After the last
  failure the delivery moves to the **DLQ** (`dead_lettered`), an alert is
  raised, and the item can be **manually replayed** (same event id, new
  delivery id).
- **Email/Telegram destinations** — SMTP and Bot API senders with templates,
  retry, delivery log and alert-loop protection (an alert delivery failure
  must not raise the same alert through the same destination).
- **Retention sweeper** _(planned)_ — deletes attachments past their
  retention (`ADR-015`: text messages retained indefinitely).

---

## 4. ADR summary

| ID | Decision |
|---|---|
| ADR-001 | Modular monolith + separate worker; no microservices. |
| ADR-002 | UnoAPI / Signal API / DBLtek are separate sidecar services, not embedded. |
| ADR-003 | Primary GoIP transport in 1.0: adapter to built-in DBLtek SMS Server v1.30.1. |
| ADR-004 | Direct GoIP UDP adapter deferred until vendor conformance tests are done. |
| ADR-005 | Core DB is the single source of truth for messages, routes, events, statuses, alerts. |
| ADR-006 | PostgreSQL is authoritative; Redis never holds the only copy of important state. |
| ADR-007 | At-least-once delivery semantics; idempotency/dedup neutralize duplicates. |
| ADR-008 | No Chatwoot-specific module; integration via generic webhook + send API. |
| ADR-009 | All ordinary channel/endpoint/webhook/alert/balance/retention settings via UI. |
| ADR-010 | Image updates, emergency password reset, infra actions stay operational (CLI). |
| ADR-011 | Interface and user messages in Ukrainian only. |
| ADR-012 | No automatic channel failover; same channel/endpoint is retried. |
| ADR-013 | Max 3 outbound attempts: 0 s, +60 s, +60 s. |
| ADR-014 | Missing delivery receipt alone is not a resend trigger. |
| ADR-015 | Text retained indefinitely; attachments have configurable retention. |
| ADR-016 | Canonical phone storage is E.164; output format configured per channel. |
| ADR-017 | LLM only as fallback for parsing complex USSD responses. |

---

## 5. Data flows

### 5.1 Outbound pipeline

```text
API client ──POST /api/v1/messages──▶ API
  ├─ Idempotency-Key lookup → existing message? → return original
  └─ DB transaction: Message(queued) + statusHistory + IdempotencyKey
       └─ enqueue BullMQ job ──▶ Worker
             ├─ MessageAttempt(1..3) → channel adapter send
             ├─ status: queued → dispatching → accepted/sent
             │   · failure → retry at +60 s (max 3 attempts, ADR-013)
             │   · final failure → status failed + alert hook
             └─ statusHistory written for every transition
                   └─ EventOutbox row (same transaction) ──▶ routing engine
```

Scheduling: `scheduled_at` defers enqueue until due. Absence of a delivery
receipt never triggers a resend (ADR-014).

### 5.2 Inbound pipeline (target)

```text
Transport sidecar ──webhook/callback──▶ API (adapter-specific ingress route)
  ├─ dedupe by (account, external_id)
  ├─ normalize to canonical model (E.164 phones, per-type content_json)
  ├─ Message(inbound, received) + Conversation upsert + statusHistory
  └─ EventOutbox(message.received) ──▶ routing engine ──▶ destinations
```

Inbound media is downloaded to local storage as `Attachment` rows and served
via short-lived signed URLs.

### 5.3 Event → routing → delivery

```text
EventOutbox ──poll/notify──▶ routing engine
  ├─ match routing rules (event type, channel, account, endpoint, direction, severity)
  ├─ fan out to N destinations (webhook | email | telegram | internal_log)
  └─ create WebhookDelivery rows (one per destination) ──▶ delivery worker
        ├─ webhook: signed POST (HMAC-SHA256), attempts 0/60/300/900/3600 s
        ├─ email/telegram: SMTP / Bot API with retry, loop protection
        ├─ failure #5 → state=dead_lettered, webhook.dead_lettered alert
        └─ operator replay → new delivery, same event_id
```

At-least-once everywhere (ADR-007); consumers deduplicate on
`X-UMG-Event-Id`.

---

## 6. Reliability baseline

- No accepted inbound event is lost on API/worker restart (outbox pattern).
- No queued outbound job is lost on Redis restart: Redis runs with AOF and,
  more importantly, **the database is re-scanable** — `queued` messages can
  always be re-enqueued from PostgreSQL (see `runbooks/queue-recovery.md`).
- All state transitions have an immutable history row; all transport
  responses are stored.
