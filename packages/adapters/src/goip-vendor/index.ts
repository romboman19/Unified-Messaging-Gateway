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
import { makeAddress } from '@umg/channel-sdk';

/**
 * Adapter for the DBLtek GoIP SMS Server v1.30.1 sidecar (TZ §21, ADR-003).
 *
 * The vendor's HTTP API exposes:
 *   POST /goip_sendsms.asp           — auth via ?Username=...&Password=...
 *   GET  /goip_get_sms_status.asp    — query delivery report for an SMS
 *   GET  /querylines.asp             — list active lines and their state
 *   POST /goip_ussd.asp              — send a USSD code, get response
 *   POST /goip_balance.asp           — request SIM balance via USSD
 *   Inbound callback                 — DBLtek POSTs to the URL configured
 *                                      on the line in our admin UI, with
 *                                      form-encoded body.
 *
 * Required per-endpoint `configJson`:
 *   { "lineId": <DBLtek line id 1..4>, "simSlot": <int 1..4> }
 *
 * Required per-account `configJson`:
 *   { "baseUrl": "http://dbtlek-vendor",
 *     "username": "<vendor login>",
 *     "password": "<vendor password>",
 *     "inboundHookSecret": "<shared secret for inbound validation>" }
 */
export class GoipVendorAdapter {
  readonly name = 'goip-vendor';

  private accountCreds(account: AccountConfig): { baseUrl: string; username: string; password: string } {
    const base = (account.configJson.baseUrl ?? '').toString().replace(/\/$/, '');
    const username = (account.configJson.username ?? '').toString();
    const password = (account.configJson.password ?? '').toString();
    if (!base) throw new Error('goip-vendor: account.configJson.baseUrl is required');
    if (!username || !password) throw new Error('goip-vendor: account.configJson.username/password required');
    return { baseUrl: base, username, password };
  }

  private lineId(endpoint: EndpointConfig): number {
    const raw = endpoint.configJson?.['lineId'] ?? endpoint.configJson?.['simSlot'];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      throw new Error(`goip-vendor: endpoint.configJson.lineId must be 1..4 (got ${String(raw)})`);
    }
    return n;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      send: ['text'],
      receive: ['text', 'unknown'],
      features: {
        delivery_status: true,
        read_status: false,
        reply: false,
        groups: false,
        reactions: false,
        voice: false,
        media: false,
      },
    };
  }

  async healthCheck(account: AccountConfig): Promise<AdapterHealth> {
    const { baseUrl, username, password } = this.accountCreds(account);
    const url = `${baseUrl}/querylines.asp?Username=${encodeURIComponent(username)}&Password=${encodeURIComponent(password)}`;
    const t0 = Date.now();
    try {
      const res = await fetch(url);
      const text = await res.text();
      // DBLtek responds with a CSV-ish block; liveness = 200 + non-empty body.
      const ok = res.ok && text.length > 0;
      return { ok, details: { httpStatus: res.status, latencyMs: Date.now() - t0, body: text.slice(0, 256) }, checkedAt: new Date() };
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
    const { baseUrl, username, password } = this.accountCreds(account);
    const line = this.lineId(endpoint);
    const text = outbound.content.text ?? '';
    const recipientRaw = outbound.to[0]?.e164 ?? outbound.to[0]?.raw ?? '';
    const recipient = recipientRaw.replace(/^\+/, '');

    const url =
      `${baseUrl}/goip_sendsms.asp?Username=${encodeURIComponent(username)}` +
      `&Password=${encodeURIComponent(password)}` +
      `&Tel=${encodeURIComponent(recipient)}` +
      `&Line=${line}` +
      `&smskey=${encodeURIComponent(outbound.idempotencyKey)}` +
      `&MsgType=text&Message=${encodeURIComponent(text)}`;

    try {
      const res = await fetch(url, { method: 'POST' });
      const body = await res.text();
      // DBLtek returns `smsOk`/false semantics in `result` field; here we treat
      // 200 + `ok` as accepted and use the idempotency key as external id since
      // DBLtek's external send id isn't always exposed.
      const accepted = res.ok && /ok/i.test(body);
      if (!accepted) {
        const retryable = res.status >= 500 || /fail|busy|queue|retr/i.test(body);
        return {
          externalId: null,
          accepted: false,
          rawResponse: body,
          error: {
            code: res.status === 200 ? 'VENDOR_REJECT' : `HTTP_${res.status}`,
            message: body.slice(0, 500),
            retryable,
          },
        };
      }
      return {
        externalId: outbound.idempotencyKey,
        accepted: true,
        rawResponse: body,
      };
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

  /** Map a vendor delivery report to a canonical status. */
  normalizeStatus(_account: AccountConfig, raw: unknown): CanonicalStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const r: any = raw;
    const status = (r.status ?? r.sms_status ?? '').toString().toLowerCase();
    const externalId = String(r.smskey ?? r.id ?? '');
    if (!externalId) return null;
    switch (status) {
      case 'sent':
      case 'dispatched':
        return { externalId, status: 'sent', updatedAt: new Date(), rawPayload: raw };
      case 'delivered':
      case 'success':
        return { externalId, status: 'delivered', updatedAt: new Date(), rawPayload: raw };
      case 'failed':
      case 'fail':
      case 'error':
        return {
          externalId,
          status: 'failed',
          updatedAt: new Date(),
          error: { code: r.err_code?.toString() ?? 'GOIP_FAILED', message: r.err_msg?.toString() ?? 'unknown', retryable: false },
          rawPayload: raw,
        };
      default:
        return null;
    }
  }

  /** Inbound callback payload from DBLtek. They POST form-encoded body with
   *  `src`, `dst`, `smskey`, `msg`, `time` (or similar). Our API ingress
   *  decrypts the shared secret and forwards the form here.
   */
  normalizeInbound(
    _account: AccountConfig,
    endpoint: EndpointConfig,
    raw: unknown,
  ): CanonicalInbound[] {
    if (!raw || typeof raw !== 'object') return [];
    const r: any = raw;
    const src = String(r.src ?? r.Source ?? r.source ?? '');
    const text = String(r.msg ?? r.Message ?? r.message ?? '');
    const tsRaw = r.time ?? r.timestamp ?? r.Time;
    const ts = typeof tsRaw === 'number' ? Number(tsRaw) : Date.now();

    if (!src || !text) return [];
    return [{
      externalId: String(r.smskey ?? r.id ?? `${src}:${ts}`),
      from: makeAddress(src),
      to: [makeAddress(String(endpoint.phoneE164 ?? endpoint.externalId ?? ''))],
      type: 'text',
      content: { text },
      receivedAt: new Date(ts),
      rawPayload: raw,
    }];
  }
}
