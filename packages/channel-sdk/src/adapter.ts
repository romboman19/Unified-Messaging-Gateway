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
}
