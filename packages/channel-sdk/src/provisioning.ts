/**
 * Provisioning types for adapters that expose a runtime "link a new device"
 * flow (TZ §1038 — Signal linked-device, UnoAPI WhatsApp pairing).
 *
 * Adapters that cannot mint runtime identities (DBLtek GoIP — physical SIMs
 * pre-installed) MUST NOT implement these methods; they report
 * `capabilities.features.provisioning === 'none'` instead.
 *
 * Lifecycle owned by the API service:
 *   unpaired → qr_pending → qr_displayed → linked | failed
 *   unpaired → sms_pending → verifying → linked | failed
 *
 * Adapters are responsible only for talking to the vendor sidecar. The API
 * persists state on `Endpoint.registrationState`.
 */
// AccountConfig is referenced from adapter.ts; this file is type-only.

export interface ProvisionedAccount {
  /** Vendor-side identifier (Signal device number, UnoAPI phone number). */
  externalId: string;
  /** E.164 phone, when known to the sidecar. */
  phoneE164: string | null;
  /** Signal-specific signal-cli UUID. Null for UnoAPI. */
  uuid: string | null;
  /** Optional human label set by the admin during the wizard. */
  deviceName?: string | null;
  /** Raw vendor response — kept for forensics. */
  raw: unknown;
}

export interface ProvisionQrInput {
  /** Caller-supplied label rendered under the QR and recorded on the endpoint. */
  deviceName: string;
}

export interface ProvisionQrResult {
  /**
   * Opaque session token the API persists on the endpoint so polling can
   * correlate polls against the originating wizard.
   */
  sessionId: string;
  /**
   * URI the QR encodes. For Signal this is an `sgnl://linkdevice?...` URI;
   * the web UI re-renders it through an inline QR generator so we never
   * render an iframe to the vendor's UI (TZ §24).
   */
  uri: string;
  /**
   * Set when the sidecar renders the QR itself and returns an image URL
   * rather than an encodable URI (gwmd). That URL resolves only from inside
   * the API container — the `transports` network is `internal: true` — so
   * the API proxies the bytes instead of handing the URL to the browser.
   */
  imageUrl?: string;
  /** TTL in seconds — after this the URI expires and a new QR is needed. */
  ttlSeconds: number;
}

export interface ProvisionSmsInput {
  phoneE164: string;
  method: 'sms' | 'voice';
  captchaToken?: string;
}

export interface ProvisionSmsResult {
  accepted: boolean;
  captchaRequired: boolean;
  /** Sidecar message id for tracing. */
  requestId: string | null;
}

export interface VerifyCodeInput {
  phoneE164: string;
  code: string;
  token?: string;
}

export interface VerifyCodeResult {
  verified: boolean;
  account: ProvisionedAccount | null;
}

/**
 * Thrown by provisioning methods for all failure modes. The API service
 * maps `code` to an HTTP status and a Ukrainian error message.
 */
export class ProvisioningError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNSUPPORTED'
      | 'TRANSPORT_ERROR'
      | 'BAD_RESPONSE'
      | 'TIMEOUT'
      | 'INVALID_INPUT',
    public readonly retryable: boolean,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}