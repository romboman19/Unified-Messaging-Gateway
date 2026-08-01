import type {
  AccountConfig,
  AdapterCapabilities,
  AdapterHealth,
  CanonicalInbound,
  CanonicalOutbound,
  CanonicalStatus,
  EndpointConfig,
  SendResult,
} from '@umg/channel-sdk';
import {
  makeAddress,
  ProvisioningError,
  type ProvisionedAccount,
  type ProvisionQrInput,
  type ProvisionQrResult,
} from '@umg/channel-sdk';

/**
 * Adapter for the `signal-cli-rest-api` sidecar
 * (https://github.com/bbernhard/signal-cli-rest-api).
 *
 * Expected sidecar base URL is provided via `account.configJson.baseUrl`.
 * Recommended sidecar mode is `MODE=json-rpc` (TZ §24) for low-latency
 * sends under concurrent load. We don't enforce this from the adapter —
 * the sidecar picks its mode at boot.
 *
 * Endpoints / payloads used by this adapter (TZ §24 + EXAMPLES.md):
 *   GET  /v1/health
 *   GET  /v1/accounts/:number
 *   POST /v2/send               — outbound
 *   GET  /v1/receive/:number    — WebSocket subscription (used by the worker
 *                                 via a separate long-poll bridge that hands
 *                                 us canonicalised payloads; here we only
 *                                 normalise).
 *   POST /v1/register/:number   — registration (voice/sms/captcha)
 *   POST /v1/register/:number/verify/:code
 *   GET  /v1/qrcodelink?device_name=...
 */
export class SignalCliRestApiAdapter {
  readonly name = 'signal-cli-rest-api';

  /** In-flight outbound dedup map (idempotency key → externalId). */
  private readonly recentSends = new Map<string, string>();

  private baseUrl(account: AccountConfig): string {
    const base = (account.configJson.baseUrl ?? '').toString().replace(/\/$/, '');
    if (!base) throw new Error('signal-cli-rest-api: account.configJson.baseUrl is required');
    return base;
  }

  private endpointNumber(endpoint: EndpointConfig): string {
    const phone = endpoint.phoneE164 ?? endpoint.externalId ?? '';
    if (!phone) {
      throw new Error('signal-cli-rest-api: endpoint missing phoneE164/externalId');
    }
    return phone.startsWith('+') ? phone : `+${phone}`;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      send: ['text', 'image', 'audio', 'voice', 'video', 'document', 'sticker', 'location', 'contact', 'reaction'],
      receive: ['text', 'image', 'audio', 'voice', 'video', 'document', 'sticker', 'location', 'contact', 'reaction', 'unknown'],
      features: {
        delivery_status: true,
        read_status: true,
        reply: true,
        groups: true,
        reactions: true,
        voice: true,
        media: true,
        // TZ §1038 — Signal exposes a linked-device QR flow.
        provisioning: 'qr',
      },
    };
  }

  async healthCheck(account: AccountConfig): Promise<AdapterHealth> {
    const url = `${this.baseUrl(account)}/v1/health`;
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'GET' });
      const body: any = await res.json().catch(() => ({}));
      return {
        ok: !!res.ok,
        details: {
          httpStatus: res.status,
          latencyMs: Date.now() - t0,
          body,
        },
        checkedAt: new Date(),
      };
    } catch (e: any) {
      return {
        ok: false,
        details: { error: e?.message ?? String(e), latencyMs: Date.now() - t0 },
        checkedAt: new Date(),
      };
    }
  }

  async send(
    outbound: CanonicalOutbound,
    endpoint: EndpointConfig,
    account: AccountConfig,
  ): Promise<SendResult> {
    const url = `${this.baseUrl(account)}/v2/send`;
    const number = this.endpointNumber(endpoint);
    const recipients = outbound.to.map((a) => a.e164 ?? a.raw).filter(Boolean) as string[];

    if (recipients.length === 0) {
      return {
        externalId: null,
        accepted: false,
        rawResponse: null,
        error: { code: 'NO_RECIPIENT', message: 'no recipients after normalisation', retryable: false },
      };
    }

    const body: Record<string, unknown> = {
      message: outbound.content.text ?? '',
      number,
      recipients,
    };
    if (outbound.content.media?.url) {
      body.base64_attachments = [outbound.content.media.url];
    }
    if (outbound.content.meta?.['link_preview']) {
      body.link_preview = outbound.content.meta['link_preview'];
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Map transport detail to canonical error (rule #1 of the contract).
        const retryable = res.status >= 500 || res.status === 429;
        return {
          externalId: null,
          accepted: false,
          rawResponse: raw,
          error: {
            code: raw?.error ?? `HTTP_${res.status}`,
            message: typeof raw === 'string' ? raw : JSON.stringify(raw),
            retryable,
          },
        };
      }
      // Sidecar returns `{ "results": { "timestamp": <ms>, ... } }` — the
      // canonical external id is the timestamp.
      const ts = raw?.results?.[recipients[0]]?.timestamp ?? raw?.timestamp;
      const externalId = ts ? String(ts) : null;
      if (externalId) this.recentSends.set(outbound.idempotencyKey, externalId);
      return { externalId, accepted: true, rawResponse: raw };
    } catch (e: any) {
      return {
        externalId: null,
        accepted: false,
        rawResponse: null,
        error: {
          code: 'NETWORK_ERROR',
          message: e?.message ?? String(e),
          retryable: true,
        },
      };
    }
  }

  normalizeStatus(_account: AccountConfig, raw: unknown): CanonicalStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const r: any = raw;
    // /v1/receive events carry envelope with `envelope.dataMessage` etc.
    if (!r.envelope && !r.dataMessage) return null;
    // We only translate receipts to canonical status when the sidecar
    // produces one; webhook payloads typically carry `syncedMessage` or
    // `receiptMessage` – map conservatively.
    if (r.receiptMessage) {
      const ts = r.receiptMessage?.timestamp ?? r.envelope?.timestamp;
      return {
        externalId: String(ts ?? ''),
        status: 'delivered',
        updatedAt: new Date(Number(r.receiptMessage?.when?.[0] ?? Date.now())),
        rawPayload: raw,
      };
    }
    if (r.dataMessage) {
      const ts = r.dataMessage?.timestamp ?? r.envelope?.timestamp;
      return {
        externalId: String(ts ?? ''),
        status: 'sent',
        updatedAt: new Date(ts ?? Date.now()),
        rawPayload: raw,
      };
    }
    return null;
  }

  normalizeInbound(
    _account: AccountConfig,
    endpoint: EndpointConfig,
    raw: unknown,
  ): CanonicalInbound[] {
    if (!raw || typeof raw !== 'object') return [];
    const r: any = raw;
    if (!r.envelope || !r.envelope.dataMessage) return [];
    const dm = r.envelope.dataMessage;
    const ts = Number(r.envelope.timestamp ?? dm.timestamp ?? Date.now());
    const from = makeAddress(String(r.envelope.source ?? r.envelope.sourceNumber ?? ''));
    const to = [makeAddress(String(this.endpointNumber(endpoint)))];
    return [{
      externalId: String(ts),
      from,
      to,
      type: dm.message ? 'text' : (dm.attachments?.length ? 'document' : 'unknown'),
      content: {
        text: dm.message ?? undefined,
        meta: dm.groupContext ? { groupId: r.envelope.dataMessage.groupContext.id ?? r.envelope.dataMessage.groupContext.groupId } : undefined,
      },
      receivedAt: new Date(ts),
      rawPayload: raw,
    }];
  }

  // ─── Provisioning (TZ §1038) — Signal linked-device via QR ────────────

  /**
   * Signal linked-device wizard — `GET /v1/qrcodelink?device_name=...`
   *
   * The phone is NOT supplied by the caller; the sidecar returns it after
   * the user scans the QR with their Signal mobile app. We persist the
   * deviceName as `sessionId` so subsequent polls can correlate.
   */
  async provisionQr(
    account: AccountConfig,
    input: ProvisionQrInput,
  ): Promise<ProvisionQrResult> {
    const deviceName = String(input.deviceName ?? '').trim();
    if (!deviceName) {
      throw new ProvisioningError(
        'deviceName is required',
        'INVALID_INPUT',
        false,
      );
    }
    const url = `${this.baseUrl(account)}/v1/qrcodelink?device_name=${encodeURIComponent(
      deviceName,
    )}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch (e: any) {
      throw new ProvisioningError(
        `signal-cli-rest-api qrcodelink network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body?.uri) {
      throw new ProvisioningError(
        `signal-cli-rest-api qrcodelink returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
        body,
      );
    }
    return {
      sessionId: deviceName,
      uri: String(body.uri),
      ttlSeconds: Number(body.expires_in ?? 600),
    };
  }

  /** `GET /v1/accounts` — list devices already paired with the sidecar. */
  async listProvisionedAccounts(account: AccountConfig): Promise<ProvisionedAccount[]> {
    const url = `${this.baseUrl(account)}/v1/accounts`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch (e: any) {
      throw new ProvisioningError(
        `signal-cli-rest-api list accounts network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    if (!res.ok) {
      throw new ProvisioningError(
        `signal-cli-rest-api list accounts returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
      );
    }
    const body: any = await res.json().catch(() => []);
    if (!Array.isArray(body)) return [];
    return body.map((a: any) => ({
      externalId: String(a?.number ?? ''),
      phoneE164: a?.number ? String(a.number) : null,
      uuid: a?.uuid ? String(a.uuid) : null,
      deviceName: a?.device_name ?? a?.deviceName ?? null,
      raw: a,
    }));
  }

  /** `DELETE /v1/accounts/{number}` — detach a paired device. */
  async unlink(account: AccountConfig, externalId: string): Promise<void> {
    const url = `${this.baseUrl(account)}/v1/accounts/${encodeURIComponent(externalId)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'DELETE' });
    } catch (e: any) {
      throw new ProvisioningError(
        `signal-cli-rest-api unlink network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    if (!res.ok && res.status !== 404) {
      throw new ProvisioningError(
        `signal-cli-rest-api unlink returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
      );
    }
  }
}
