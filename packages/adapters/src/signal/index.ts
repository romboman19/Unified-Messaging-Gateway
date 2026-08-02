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
 *   GET  /v1/qrcodelink/raw?device_name=...
 *
 * NOTE on the QR endpoint: `GET /v1/qrcodelink` renders the link URI to a
 * PNG and responds with `image/png` — it is NOT a JSON endpoint. The JSON
 * sibling is `/v1/qrcodelink/raw`, which returns
 * `{ "device_link_uri": "sgnl://linkdevice?uuid=…&pub_key=…" }`. We use the
 * raw variant and render the QR ourselves in the browser (TZ §24 — never
 * embed the vendor's UI).
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
        // signal-cli knows exactly why a send failed — its json-rpc reply
        // carries `results[].type`, e.g. UNREGISTERED_FAILURE — but the REST
        // wrapper collapses all of it to "Failed to send message". Ask the
        // registration lookup instead so the admin gets a reason rather than a
        // shrug. Only on the failure path, so successful sends pay nothing.
        const unregistered = await this.findUnregistered(account, number, recipients);
        if (unregistered.length > 0) {
          return {
            externalId: null,
            accepted: false,
            rawResponse: raw,
            error: {
              code: 'RECIPIENT_NOT_REGISTERED',
              message: `Не зареєстровані в Signal: ${unregistered.join(', ')}`,
              retryable: false,
            },
          };
        }
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
      // The real sidecar answers 201 with an ARRAY of
      // `{ timestamp, errors? }` (datastructs.SendMessageResponse), one entry
      // per recipient. The timestamp doubles as Signal's message id, so it is
      // our external id. Older shapes are still accepted for the dev stub.
      const first = Array.isArray(raw) ? raw[0] : null;
      if (first?.errors) {
        return {
          externalId: null,
          accepted: false,
          rawResponse: raw,
          error: {
            code: 'SIGNAL_SEND_ERROR',
            message: JSON.stringify(first.errors),
            retryable: false,
          },
        };
      }
      const ts =
        first?.timestamp ??
        raw?.results?.[recipients[0]]?.timestamp ??
        raw?.timestamp;
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

  /**
   * `GET /v1/search/{account}?numbers=…` asks Signal's discovery service which
   * of the numbers actually have a Signal account. Returns the ones that do
   * not. Never throws: this only ever runs to enrich an error message, and a
   * failed lookup must not mask the original send failure.
   */
  private async findUnregistered(
    account: AccountConfig,
    fromNumber: string,
    recipients: string[],
  ): Promise<string[]> {
    try {
      // The endpoint reads `numbers` as a repeated query parameter; a
      // comma-joined value is rejected with CdsiInvalidArgumentException.
      const query = recipients
        .map((r) => `numbers=${encodeURIComponent(r)}`)
        .join('&');
      const url = `${this.baseUrl(account)}/v1/search/${encodeURIComponent(
        fromNumber,
      )}?${query}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return [];
      const body: any = await res.json().catch(() => []);
      if (!Array.isArray(body)) return [];
      return body
        .filter((entry: any) => entry?.registered === false)
        .map((entry: any) => String(entry?.number ?? ''))
        .filter(Boolean);
    } catch {
      return [];
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
   * Signal linked-device wizard — `GET /v1/qrcodelink/raw?device_name=...`
   *
   * The sidecar calls signal-cli's `startLink`, hands us back the
   * `sgnl://linkdevice?...` URI, and finishes the handshake in a background
   * goroutine once the admin scans it. The phone number is NOT supplied by
   * the caller — it appears in `GET /v1/accounts` after the scan succeeds.
   *
   * We persist the deviceName as `sessionId`; the API correlates the linked
   * number by diffing the account list against the pre-link snapshot, since
   * the sidecar's account list carries no device name.
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
    const url = `${this.baseUrl(account)}/v1/qrcodelink/raw?device_name=${encodeURIComponent(
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
    // Real sidecar: `device_link_uri`. Dev stub: `uri`.
    const uri = body?.device_link_uri ?? body?.uri;
    if (!res.ok || !uri) {
      throw new ProvisioningError(
        `signal-cli-rest-api qrcodelink returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
        body,
      );
    }
    return {
      sessionId: deviceName,
      uri: String(uri),
      // The sidecar reports no expiry; signal-cli's provisioning URI is
      // valid for a few minutes server-side. 10 min matches the wizard's
      // patience without leaving stale rows around forever.
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
    // The real sidecar returns a bare `["+380…", …]` — signal-cli's
    // `listAccounts` output is flattened to numbers before it reaches us, so
    // there is no uuid and no device name to match on. The dev stub returns
    // objects; accept both shapes.
    return body.map((a: any) => {
      if (typeof a === 'string') {
        return { externalId: a, phoneE164: a, uuid: null, deviceName: null, raw: a };
      }
      const number = a?.number ? String(a.number) : '';
      return {
        externalId: number,
        phoneE164: number || null,
        uuid: a?.uuid ? String(a.uuid) : null,
        deviceName: a?.device_name ?? a?.deviceName ?? null,
        raw: a,
      };
    });
  }

  /**
   * `DELETE /v1/devices/{number}/local-data` — drop this installation's copy
   * of the account.
   *
   * UMG is itself a *linked device* of the admin's phone, so "unlink" means
   * forgetting our local keys; the primary account is untouched and the
   * admin removes the stale entry from Signal → Linked devices. There is no
   * `DELETE /v1/accounts/{number}` on the real sidecar.
   */
  async unlink(account: AccountConfig, externalId: string): Promise<void> {
    const url = `${this.baseUrl(account)}/v1/devices/${encodeURIComponent(
      externalId,
    )}/local-data`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        // Without this signal-cli refuses to drop the data of a still-registered
        // account and answers 400, so unlinking never worked from the UI. We
        // *are* the linked device: forgetting our own keys is the whole point,
        // and the primary account on the admin's phone is untouched.
        body: JSON.stringify({ ignore_registered: true }),
      });
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
