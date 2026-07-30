# Data Model

PostgreSQL 17 via Prisma (`packages/database/prisma/schema.prisma`).
PostgreSQL is the single source of truth (ADR-005/006). UUID primary keys
throughout (`@default(uuid())`).

> **Status note.** This document first describes the models that exist in the
> current schema, then the additional entities required by Milestone 1+
> (MessageEvent/routing, destinations, deliveries, attachments, alerts).
> At the time of writing those are being added by parallel work; where they
> are not yet in `schema.prisma` they are marked **[Planned]** with the
> agreed target shape. The Prisma schema remains the authority; update this
> file whenever it changes.

---

## 1. Entity overview (current schema)

```text
AdminUser ────────< AuditLog
GlobalApiToken           (no relations; hash only)
TransportAccount ────< Endpoint ────< Conversation ────<
       │                   │                              │
       └───────────────────┴─────────────< Message >──────┘
                                              │
                          ┌───────────────────┼───────────────────┐
                     MessageAttempt    MessageStatusHistory    (Attachment [Planned])
EventOutbox                                  (no relations; outbox table)
IdempotencyKey / SystemSetting               (utility tables)
```

## 2. Access & identity

### `admin_users` (AdminUser)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| username | text unique | Single local admin in release 1.0 |
| password_hash | text | Argon2id |
| last_login_at | timestamptz? | |
| created_at / updated_at | timestamptz | |

The bootstrap password from `ADMIN_BOOTSTRAP_PASSWORD` is used only while the
table is empty; rotation happens through the UI.

### `global_api_tokens` (GlobalApiToken)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text (`default`) | Operator label, e.g. `n8n-integration` |
| token_hash | text | Only the hash is stored; plaintext shown once |
| created_at / last_used_at / revoked_at | timestamptz | `revoked_at` = soft revoke |

### `audit_logs` (AuditLog)
Immutable audit trail (spec §29.6): `actor_id → admin_users.id` (nullable for
`system`), `action`, `entity_type`, `entity_id`, `before_json`,
`after_json`, `created_at` (indexed). Secrets are never stored in
before/after payloads.

---

## 3. Channels

### `transport_accounts` (TransportAccount)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| type | enum `channel_type` | `sms`, `whatsapp`, `signal`, `mock` |
| adapter | text | `mock` today; `goip-vendor`, `unoapi`, `signal-cli-rest-api` planned |
| name | text | Display name (Ukrainian UI) |
| status | enum `transport_status` | `active` (default), `inactive`, `degraded`, `disabled` |
| encrypted_config | jsonb | Adapter config incl. credentials — **encrypted at rest** |
| created_at / updated_at | timestamptz | |

### `endpoints` (Endpoint)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| account_id | uuid FK | → `transport_accounts.id` |
| external_id | text? | Vendor-side id (SIM slot, session id, Signal number) |
| phone_raw | text? | As entered by operator |
| phone_e164 | text? | Canonical E.164 (ADR-016) |
| label | text | Operator-facing label |
| enabled | boolean | default `true` |
| config_json | jsonb | Non-secret per-endpoint config |
| created_at / updated_at | timestamptz | |

---

## 4. Messaging

### `messages` (Message)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| direction | enum `message_direction` | `inbound` / `outbound` |
| channel_type | enum | same enum as account type |
| account_id / endpoint_id | uuid FK | |
| conversation_id | uuid FK? | → `conversations.id` |
| external_id | text? | Transport-side message id (dedup key) |
| message_type | enum `message_type` | `text`, `image`, `audio`, `voice`, `video`, `document`, `sticker`, `location`, `contact`, `reaction`, `reply`, `interactive`, `poll`, `system`, `unknown` |
| status | enum `message_status` | `created`, `scheduled`, `queued`, `dispatching`, `accepted`, `sent`, `delivered`, `read`, `failed`, `cancelled`, `expired`, `unknown`, `received`, `assembling`, `incomplete`, `processed`, `forwarded`, `forward_failed` |
| from_json / to_json | jsonb | `{ raw, e164, display }` |
| content_json | jsonb | Type-dependent payload (`{ text }`, media refs…) |
| metadata_json | jsonb | Client-supplied metadata, echoed into events |
| raw_payload | jsonb | Original request/adapter payload, always kept |
| scheduled_at | timestamptz? | Deferred send |
| created_at / updated_at | timestamptz | |

Indexes: `(endpoint_id, status, created_at)`, `(created_at)` — tuned for the
messages table p95 < 2 s at 100 k records with server-side pagination.

### `message_attempts` (MessageAttempt)
Per-send attempt: `message_id FK` (indexed), `attempt_no`, `started_at`,
`finished_at?`, `result`, `error_json?`. Max 3 attempts (ADR-013).

### `message_status_history` (MessageStatusHistory)
Immutable transition log: `message_id`, `status`, `source`
(`api`/`worker`/`callback`…), `payload`, `created_at`; indexed
`(message_id, created_at)`. Every status change writes one row (spec §33.1).

### `conversations` (Conversation)
Grouping of messages by peer: `channel_type`, `endpoint_id FK`,
`peer_id`, `peer_phone_e164`, `last_message_at`. Used by the UI conversation
view and inbound routing.

---

## 5. Eventing & utilities

### `event_outbox` (EventOutbox)
Transactional outbox backing the routing engine: `event_type`,
`aggregate_id`, `payload` (canonical CloudEvents-compatible envelope,
spec §15.3), `published_at?` (indexed), `created_at`. Written in the same
transaction as the business change → no event loss on restart.

### `idempotency_keys` (IdempotencyKey)
`key` (PK, client header value), `request_hash`, `response_ref` (created
entity id), `expires_at` (indexed; 7-day retention). Guarantees at-most-once
effect for `POST /messages` repeats (ADR-007).

### `system_settings` (SystemSetting)
`key` PK, `value_json`, `encrypted` flag — runtime-configurable settings
(ADR-009: configured through UI).

---

## 6. Milestone 1+ entities [Planned]

The following entities are required by the spec and either freshly added or
still landing in the schema. Document them, then reconcile against
`schema.prisma` once merged.

### [Planned] `message_events` / routing event storage
Events flowing through the routing engine, derived from `event_outbox` rows:
canonical envelope (`specversion`, `id`, `type`, `source`, `subject`,
`time`, `channel`, `account_id`, `endpoint_id`, `event_version`, `data`).
Event types per spec §15.2 include `message.received`, `message.queued`,
`message.sent`, `message.delivered`, `message.failed`,
`channel.connected/degraded/disconnected`, `endpoint.enabled/disabled`,
`sim.balance.*`, `webhook.delivery.failed`, `webhook.dead_lettered`,
`queue.backlog`, `storage.low`, `system.component.unhealthy/recovered`,
`media.deleted`.

### [Planned] `routing_rules` (RoutingRule)
| Field | Notes |
|---|---|
| id, name, enabled | |
| filters_json | event types, channel types, account ids, endpoint ids, direction, severity (spec §15.1) |
| created_at / updated_at | |

N:N link table `routing_rule_destinations(rule_id, destination_id)` — one
event fans out to many destinations.

### [Planned] `webhook_destinations` (WebhookDestination)
| Field | Notes |
|---|---|
| id, name, enabled | |
| type | `webhook` / `email` / `telegram` / `internal_log` |
| encrypted_config | URL, signing secret, SMTP credentials, Telegram token — encrypted at rest, never returned by API |
| created_at / updated_at | |

### [Planned] `webhook_deliveries` (WebhookDelivery)
| Field | Notes |
|---|---|
| id, destination_id FK | |
| event_id | Same across replays |
| event_type, payload_json | Snapshot of what is signed/sent |
| state | `pending` → `delivered` / `failed` → (after 5th attempt) `dead_lettered` |
| attempt_no, next_attempt_at | Schedule 0/60/300/900/3600 s |
| response_status, response_body_excerpt | Shown in UI + alert |
| replay_of_id? | Links a manual replay to the original delivery |

### [Planned] `attachments` (Attachment)
| Field | Notes |
|---|---|
| id, message_id FK? | Linked when referenced by a message |
| filename, content_type, size_bytes | |
| storage_path | Under `umg-media-data` volume; served via signed URL |
| sha256 | Integrity |
| expires_at | Configurable retention (ADR-015); sweep deletes file + row → `media.deleted` event |
| created_at | |

Join table `message_attachments(message_id, attachment_id)` for N:N reuse.

### [Planned] `alerts` (Alert)
Stateful incidents (spec §18.1): `type` (e.g. `channel.degraded`,
`webhook.dead_lettered`, `queue.backlog`, `storage.low`, `sim.balance.low`),
`severity` (`info`/`warning`/`critical`),
`state` (`open` → `acknowledged` → `resolved`), `message` (Ukrainian),
`dedup_key` (prevents duplicate streams of the same incident),
timestamps, `acknowledged_by → admin_users.id`.

### [Planned] `alert_rules` (AlertRule)
Threshold configuration for alert generation (queue depth, storage %,
balance thresholds), N:N to destinations.

---

## 7. Conventions

- All tables snake_case via `@@map`; columns via `@map`.
- Enums are Prisma enums mapped to lowercase PostgreSQL enum types.
- Every destructive action is preceded by audit snapshot (`before_json`).
- Retention: texts forever; attachments per policy; outbox/delivery rows may
  be pruned after configurable age once delivered/dead-lettered.
