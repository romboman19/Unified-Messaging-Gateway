/**
 * Canonical types for transport adapters.
 *
 * Every adapter (sms/whatsapp/signal/mock) maps vendor-specific data into
 * this single shape. The core never sees vendor payloads — they are kept in
 * `rawPayload`/`rawResponse` for forensics only.
 */

export type ChannelType = 'sms' | 'whatsapp' | 'signal' | 'mock';

/** E.164 phone number, e.g. "+380671234567". Used as canonical identifier. */
export type E164 = string;

/** Address object — always stored in canonical form. */
export interface CanonicalAddress {
  /** Original raw value as received from the transport. */
  raw: string;
  /** E.164 form. May be null when the peer cannot be normalised (e.g. group JID, UUID). */
  e164: string | null;
  /** Human-readable display form, e.g. "067 123 45 67". Best-effort. */
  display: string | null;
}

/** Canonical message body. All fields are best-effort; transports may omit. */
export interface CanonicalContent {
  text?: string;
  /** For media messages: filename / mime / size. Files are uploaded to UMG storage. */
  media?: {
    url?: string;
    mime?: string;
    filename?: string;
    size?: number;
    sha256?: string;
  };
  /** Voice note specific flag. */
  voice?: boolean;
  /** Reaction emoji (for `reaction` messages). */
  reaction?: string;
  /** Reply / quoted message id (canonical, not vendor). */
  replyToMessageId?: string;
  /** Free-form metadata for transport-specific bits not covered above. */
  meta?: Record<string, unknown>;
}

/** Type tag for the canonical message. Unknown transports send `unknown`. */
export type CanonicalMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'voice'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'reaction'
  | 'reply'
  | 'interactive'
  | 'poll'
  | 'system'
  | 'unknown';

/** Inbound message handed to the core by an adapter. */
export interface CanonicalInbound {
  /** Vendor's transport-side id (used for dedupe `(endpoint_id, external_id)`). */
  externalId: string;
  /** Sender. */
  from: CanonicalAddress;
  /** Recipients (multiple for groups). */
  to: CanonicalAddress[];
  type: CanonicalMessageType;
  content: CanonicalContent;
  receivedAt: Date;
  /** For group messages: vendor group id. */
  groupId?: string;
  /** Original transport payload (JSON-serialisable). Stored for forensics. */
  rawPayload: unknown;
}

/** Status callback handed to the core by an adapter. */
export type CanonicalStatusName =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'unknown';

export interface CanonicalStatus {
  /** Vendor's message id (matches the one returned from `send`). */
  externalId: string;
  status: CanonicalStatusName;
  updatedAt: Date;
  /** Error details if status is `failed`. */
  error?: { code: string; message: string; retryable: boolean };
  rawPayload?: unknown;
}

/** Outbound request from the core to an adapter. */
export interface CanonicalOutbound {
  /** Canonical message id. Used for idempotency (at-least-once tolerated). */
  messageId: string;
  /** Idempotency key derived from message id, also usable as transport-side dedup id. */
  idempotencyKey: string;
  /** Recipient(s). */
  to: CanonicalAddress[];
  type: CanonicalMessageType;
  content: CanonicalContent;
  /** Optional reference to a message we reply to. */
  replyToMessageId?: string;
  /** Optional reference to a previously uploaded media id in UMG storage. */
  attachmentId?: string;
}

/** Result returned by `send()`. Adapters MUST persist `rawResponse`. */
export interface SendResult {
  /** Vendor's id for the sent message. May be null if transport hasn't acknowledged yet. */
  externalId: string | null;
  /** Whether the transport accepted the send (created a job / assigned an id). */
  accepted: boolean;
  /** Original transport response. Always persisted for forensics (§33.1 of TZ). */
  rawResponse: unknown;
  /** Error details when the send was rejected. */
  error?: { code: string; message: string; retryable: boolean };
}

/** Capability matrix as defined in TZ §9.2. */
export interface AdapterCapabilities {
  /** Message types the adapter can send. */
  send: CanonicalMessageType[];
  /** Message types the adapter can receive. */
  receive: CanonicalMessageType[];
  /** Feature flags. */
  features: {
    delivery_status?: boolean;
    read_status?: boolean;
    reply?: boolean;
    groups?: boolean;
    reactions?: boolean;
    voice?: boolean;
    media?: boolean;
  };
}

/** Adapter-reported health snapshot. */
export interface AdapterHealth {
  ok: boolean;
  /** Free-form details (latency ms, transport version, line counts, ...). */
  details?: Record<string, unknown>;
  /** When the check was performed. */
  checkedAt: Date;
}

/** Adapter context — encrypted config blob parsed per-adapter. */
export interface EndpointConfig {
  /** Internal endpoint id. */
  id: string;
  /** Vendor-specific external id (vendor line id, UnoAPI session id, Signal account number). */
  externalId: string;
  /** Phone in E.164 form. */
  phoneE164: E164 | null;
  /** Display label (operator / line tag). */
  label: string;
  /** Decrypted per-endpoint JSON config (e.g. SIM slot, group policy, ...). */
  configJson: Record<string, unknown>;
}

export interface AccountConfig {
  /** Internal transport account id. */
  id: string;
  /** Adapter name — e.g. "mock", "goip-vendor", "unoapi", "signal-cli-rest-api". */
  adapter: string;
  /** Decrypted per-account JSON config (base URL, vendor creds, ...). */
  configJson: Record<string, unknown>;
}
