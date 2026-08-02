import type {
  AccountConfig,
  AdapterCapabilities,
  AdapterHealth,
  CanonicalInbound,
  CanonicalOutbound,
  CanonicalStatus,
  EndpointConfig,
  SendResult,
} from './types.js';
import type {
  ProvisionedAccount,
  ProvisionQrInput,
  ProvisionQrResult,
  ProvisionSmsInput,
  ProvisionSmsResult,
  VerifyCodeInput,
  VerifyCodeResult,
} from './provisioning.js';

/**
 * Contract every transport adapter implements.
 *
 * Rules (TZ `adapters.md` §1):
 *  1. Never throw transport detail into the core — map to `{ code, retryable }`.
 *  2. Persist everything raw via `SendResult.rawResponse` / `CanonicalInbound.rawPayload`.
 *  3. Tolerate at-least-once — use transport-level dedup ids where available.
 *  4. Missing status receipts never cause a resend (best-effort).
 *  5. Vendor-specific fields live in `Endpoint.externalId` / `configJson`, never in core.
 */
export interface ChannelAdapter {
  /** Adapter name, e.g. "mock", "goip-vendor", "unoapi", "signal-cli-rest-api". */
  readonly name: string;

  /** Capability matrix — drives UI and API gating. */
  capabilities(): Promise<AdapterCapabilities>;

  /** Liveness check. */
  healthCheck(account: AccountConfig): Promise<AdapterHealth>;

  /** Outbound send. */
  send(
    outbound: CanonicalOutbound,
    endpoint: EndpointConfig,
    account: AccountConfig,
  ): Promise<SendResult>;

  /** Map a vendor status payload to canonical. Return null when unrecognised. */
  normalizeStatus(account: AccountConfig, raw: unknown): CanonicalStatus | null;

  /** Map a vendor inbound payload to canonical message(s). May return zero. */
  normalizeInbound(
    account: AccountConfig,
    endpoint: EndpointConfig,
    raw: unknown,
  ): CanonicalInbound[];

  /** Optional: prepare an adapter (verify creds, open long-lived connections). */
  init?(account: AccountConfig): Promise<void>;

  /** Optional: tear down. */
  shutdown?(account: AccountConfig): Promise<void>;

  // ─── Provisioning (TZ §1038) — optional, only QR/SMS-capable adapters ──
  // Adapters that cannot mint runtime identities (DBLtek GoIP — physical
  // SIMs pre-installed) MUST NOT implement these; they advertise
  // `capabilities.features.provisioning === 'none'` instead.

  /** Start a QR-linked-device wizard. Returns a URI to render + a session id. */
  provisionQr?(account: AccountConfig, input: ProvisionQrInput): Promise<ProvisionQrResult>;

  /** Start an SMS / voice verification flow. */
  provisionSms?(account: AccountConfig, input: ProvisionSmsInput): Promise<ProvisionSmsResult>;

  /** Submit the verification code the admin received. */
  verifyCode?(account: AccountConfig, input: VerifyCodeInput): Promise<VerifyCodeResult>;

  /**
   * Fetch a QR image the sidecar rendered itself, given the `imageUrl` from
   * `provisionQr`. Implemented only by adapters whose sidecar serves the QR
   * as an image on the internal `transports` network; the API proxies the
   * bytes out to the browser, which cannot reach that network.
   */
  fetchProvisioningImage?(
    account: AccountConfig,
    imageUrl: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;

  /**
   * Download an inbound attachment the sidecar is holding, given a `ref` from
   * `CanonicalContent.attachments`. Implemented by adapters whose transport
   * delivers files by reference rather than inline.
   */
  fetchInboundMedia?(
    account: AccountConfig,
    ref: string,
  ): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }>;

  /** List devices/accounts already linked on the sidecar (reconcile orphans). */
  listProvisionedAccounts?(account: AccountConfig): Promise<ProvisionedAccount[]>;

  /** Detach / logout a device from the sidecar. */
  unlink?(account: AccountConfig, externalId: string): Promise<void>;
}
