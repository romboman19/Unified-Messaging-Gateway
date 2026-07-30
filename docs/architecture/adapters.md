# Transport Adapters

How UMG talks to physical messaging channels. Governing decisions:

- **ADR-002** — UnoAPI, Signal API and DBLtek SMS Server are **not embedded**
  into core code; they run as separate transport services/sidecars.
- **ADR-003** — the primary GoIP transport in release 1.0 is an adapter to the
  built-in **DBLtek SMS Server v1.30.1**.
- **ADR-004** — a direct GoIP UDP adapter is deferred until conformance tests
  against the vendor stack are finished.
- **ADR-005/006** — core PostgreSQL remains the source of truth for every
  message, status and event regardless of adapter behaviour.

---

## 1. Adapter contract concept

`packages/channel-sdk` defines the contract every adapter implements. The
core is transport-agnostic: it stores canonical messages (E.164 phones,
typed `content_json`, JSON addresses `{raw, e164, display}`) and asks the
adapter to do the transport-specific work.

Conceptual interface:

```ts
interface ChannelAdapter {
  readonly name: string;                    // e.g. "mock", "goip-vendor"
  capabilities(): AdapterCapabilities;      // send, receive, media, receipts, ussd, balance
  healthCheck(): Promise<AdapterHealth>;
  send(msg: CanonicalOutbound, endpoint: EndpointConfig): Promise<SendResult>;
  // Inbound: adapter serves/exposes a callback endpoint and forwards
  // normalized events into the core ingress route.
  normalizeInbound(raw: unknown): CanonicalInbound[];
  normalizeStatus(raw: unknown): CanonicalStatus | null;
}

interface SendResult {
  externalId: string | null;
  accepted: boolean;
  rawResponse: unknown;        // always persisted (spec §33.1)
  error?: { code: string; message: string; retryable: boolean };
}
```

Contract rules:

1. **Never throw transport detail into the core model** — map to
   `{ code, retryable }`. Retryable errors consume the 3-attempt budget
   (ADR-013); non-retryable errors mark the message `failed` immediately.
2. **Persist everything raw** — request/response payloads go to
   `Message.rawPayload` / attempt `errorJson` for forensics.
3. **Idempotent sends** — adapters must tolerate being called with the same
   message id twice (at-least-once, ADR-007) and use transport-level dedup
   IDs where available.
4. **Status receipts are best-effort** — a missing receipt never causes a
   resend (ADR-014).
5. **Canonical mapping** — vendor-specific fields (SIM slot, session id,
   group id, Signal UUID) live in `Endpoint.externalId` / `configJson`,
   never in the core tables.

---

## 2. Current adapter: `mock`

The mock adapter ships with Milestone 0 and backs the smoke test end to end.

- Auto-provisioned on first use: account "Mock channel", endpoint
  "Mock endpoint" (`externalId = mock-1`).
- `send()` accepts everything and simulates the lifecycle
  `queued → dispatching → sent → delivered`.
- No external calls; used for development, CI contract tests and UI work.

---

## 3. Planned adapters

### 3.1 `goip-vendor` — DBLtek SMS Server (SMS, release 1.0)

| | |
|---|---|
| **Sidecar** | Vendor archive `goip_install-v1.30.1.tar.gz` unpacked into its own container (old PHP/MySQL stack, fully isolated). Archive is **not committed**; a local build script verifies SHA-256. |
| **Core ↔ sidecar** | Private HTTP/JSON inside the `transports`/`goip` Docker networks. Vendor container is **not reachable from the LAN** and SHOULD have no internet egress. |
| **Hardware path** | GoIP-4 / 4 SIM talk UDP 44444 to the vendor server only. |
| **Endpoint mapping** | Endpoint = SIM slot/line; `externalId` = vendor line id; phone in E.164. |
| **Capabilities** | send text SMS, receive SMS, delivery receipts (best-effort), USSD + balance query (deterministic parsers, LLM fallback per ADR-017). |
| **Rollback** | See `runbooks/goip-rollback.md`. |

### 3.2 `goip-native` — direct GoIP UDP (experimental only)

Stub package per ADR-004. Written only after conformance tests against the
vendor stack prove the UDP protocol behaviour. Not part of release 1.0.

### 3.3 `unoapi` — WhatsApp via UnoAPI/Baileys

| | |
|---|---|
| **Sidecar** | UnoAPI container (own volume `umg-unoapi-data` for sessions). GPL-3.0 — kept as a separate container, no source copied into core; see `licensing/third-party.md`. |
| **Core ↔ sidecar** | Private HTTP for send commands; UnoAPI webhooks POST inbound events and receipts back to the API ingress route. |
| **Endpoint mapping** | Endpoint = linked WhatsApp number (`externalId` = UnoAPI session/phone id). |
| **Capabilities** | text + media messages, receipts (`sent`/`delivered`/`read`), group ids in `configJson`. |
| **Risk** | Unofficial protocol integration; owner accepts blocking/protocol-change risk. Reconnect procedure: `runbooks/whatsapp-reconnect.md`. |

### 3.4 `signal-cli-rest-api` — Signal

| | |
|---|---|
| **Sidecar** | `signal-cli-rest-api` container wrapping `signal-cli` (json-rpc mode recommended under concurrent load); volume `umg-signal-data` holds keys/registration — **sensitive data**, included in backups. |
| **Core ↔ sidecar** | Private HTTP REST for send; receive via its event endpoint/webhook into the API ingress route. |
| **Endpoint mapping** | Endpoint = registered Signal number (`externalId` = account number/id). |
| **Capabilities** | text + attachments, receipts where available. |
| **Relink** | `runbooks/signal-relink.md`. |

---

## 4. Canonical model mapping summary

| Core field | sms (goip-vendor) | whatsapp (unoapi) | signal |
|---|---|---|---|
| `Endpoint.externalId` | vendor line id | session/phone id | account number |
| `to_json.e164` | MSISDN | chat JID ↔ E.184 map | E.164 / UUID |
| `content_json.text` | UCS-2/GSM-7 SMS text | body text | body text |
| `attachments[]` | — | media upload → send | file send |
| receipt → status | report → `delivered` | ticks → `sent`/`delivered`/`read` | receipts where available |

Phone numbers are stored canonically as **E.164**; per-channel output
formatting is configured on the endpoint (ADR-016).

---

## 5. Adding a new adapter

1. Create `packages/adapter-<name>` implementing the `channel-sdk` contract.
2. Add contract fixtures (recorded transports) under `tests/contract/`.
3. Register the adapter name; the UI and account CRUD pick it up via the
   `adapter` field on `TransportAccount` — no core DB changes required.
4. Add the sidecar service to `docker-compose.yml` on the `transports`
   network only, plus a runbook and licensing note where applicable.
