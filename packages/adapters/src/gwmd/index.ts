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
 * Adapter for go-whatsapp-web-multidevice
 * (https://github.com/aldinokemal/go-whatsapp-web-multidevice), a Go REST
 * wrapper around whatsmeow that exposes a multi-device WhatsApp Web session
 * per `device_id`.
 *
 * We use this in place of UnoAPI because UnoAPI 2.x no longer returns QR
 * codes in a JSON HTTP response — pairing happens via a socket.io WebSocket
 * — which doesn't fit our wizard-driven QR flow. gwmd v1+ returns a JSON
 * envelope `{ qr_link, qr_duration, device_id }` from
 * `GET /devices/:device_id/login`; `qr_link` is an HTTPS URL the sidecar
 * itself serves (a PNG of the QR), so the web UI can either:
 *   - fetch the URL directly (if the sidecar is exposed on a network the
 *     browser can reach), or
 *   - call `GET /api/v1/transport-accounts/:id/provision/:endpointId/qr.png`,
 *     a small API proxy that streams the sidecar image back with CORS
 *     headers.
 *
 * Required config (`account.configJson`):
 *   baseUrl:   e.g. "http://gwmd:3000"
 *   username:  basic-auth user (gwmd's `WEBHOOK_USERNAME` / BasicAuth user)
 *   password:  basic-auth password (gwmd's `WEBHOOK_PASSWORD`)
 *
 * The gwmd endpoint list is documented in its README and
 * `src/ui/rest/device.go`; this adapter uses the stable subset:
 *   GET  /app/devices
 *   POST /app/devices                     (create session)
 *   GET  /app/devices/:device_id/status   (poll — paired? → `is_logged_in`)
 *   GET  /app/devices/:device_id/login    (mint QR)
 *   DELETE /app/devices/:device_id        (logout)
 *
 * NOTE: gwmd mounts its REST under an `AppBasePath` (default `/app`); the
 * service is configured with `--app-base-path /app` and we hardcode `/app`
 * here. If you change `AppBasePath` on the sidecar, mirror it here.
 */
export class GwmdAdapter {
  readonly name = 'gwmd';

  private baseUrl(account: AccountConfig): string {
    const base = (account.configJson.baseUrl ?? '').toString().replace(/\/$/, '');
    if (!base) throw new Error('gwmd: account.configJson.baseUrl is required');
    return base;
  }

  private authHeader(account: AccountConfig): string | undefined {
    const user = (account.configJson.username ?? '').toString();
    const pass = (account.configJson.password ?? '').toString();
    if (!user || !pass) return undefined;
    // Node Buffer is available globally in NestJS/Node runtimes.
    const token = Buffer.from(`${user}:${pass}`).toString('base64');
    return `Basic ${token}`;
  }

  private authHeaders(account: AccountConfig): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    const auth = this.authHeader(account);
    if (auth) h.authorization = auth;
    return h;
  }

  private deviceIdOf(endpoint: EndpointConfig): string {
    const id = (endpoint.externalId ?? endpoint.configJson?.['device_id'] ?? '').toString();
    if (!id) throw new Error('gwmd: endpoint missing externalId/device_id');
    return id;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      send: ['text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contact', 'reaction'],
      receive: ['text', 'image', 'audio', 'voice', 'video', 'document', 'sticker', 'location', 'contact', 'reaction', 'unknown'],
      features: {
        delivery_status: true,
        read_status: true,
        reply: true,
        groups: true,
        reactions: true,
        media: true,
        // TZ §1038 — gwmd exposes a QR pairing flow per device.
        provisioning: 'qr',
      },
    };
  }

  async healthCheck(account: AccountConfig): Promise<AdapterHealth> {
    const url = `${this.baseUrl(account)}/app/devices`;
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'GET', headers: this.authHeaders(account) });
      return {
        ok: res.ok,
        details: { httpStatus: res.status, latencyMs: Date.now() - t0 },
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
    const deviceId = this.deviceIdOf(endpoint);
    const url = `${this.baseUrl(account)}/app/send/${encodeURIComponent(deviceId)}`;
    const recipient = outbound.to[0]?.e164 ?? outbound.to[0]?.raw ?? '';
    const payload: Record<string, unknown> = {
      phone: recipient.replace(/^\+/, ''),
      message: outbound.content.text ?? '',
    };
    if (outbound.content.replyToMessageId) {
      payload['reply_message_id'] = outbound.content.replyToMessageId;
    }
    if (outbound.content.media?.url) {
      // gwmd accepts media URL via the `media_url` field (image/video/document).
      payload['media_url'] = outbound.content.media.url;
    }
    if (outbound.content.reaction) {
      payload['reaction'] = outbound.content.reaction;
      payload['message_id'] = outbound.content.replyToMessageId;
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(account),
        body: JSON.stringify(payload),
      });
      const raw: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        return {
          externalId: null,
          accepted: false,
          rawResponse: raw,
          error: {
            code: raw?.code ?? raw?.error ?? `HTTP_${res.status}`,
            message: raw?.message ?? JSON.stringify(raw),
            retryable,
          },
        };
      }
      // gwmd returns either { results: { message_id } } or { data: { message_id } }
      // depending on the version; pick whichever is present.
      const externalId: string | null =
        raw?.results?.message_id ?? raw?.data?.message_id ?? raw?.message_id ?? null;
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
   * gwmd delivers inbound + receipt events via webhook
   * (`--webhook-url`). The worker subscribes and routes the payloads
   * here for canonicalisation.
   */
  normalizeInbound(_account: AccountConfig, _endpoint: EndpointConfig, raw: unknown): CanonicalInbound[] {
    if (!raw || typeof raw !== 'object') return [];
    const r: any = raw;
    // gwmd webhook envelope: { event: "message", payload: { ... } }.
    if (r.event && r.event !== 'message') return [];
    const m: any = r.payload ?? r;
    if (!m || (!m.message && !m.image && !m.video && !m.document && !m.audio)) return [];
    const ts = Number(m.timestamp ?? Date.now());
    const from = makeAddress(String(m.from ?? m.sender ?? ''));
    const to = [makeAddress(String(m.to ?? _endpoint.phoneE164 ?? ''))];
    const type = m.image ? 'image' : m.video ? 'video' : m.audio ? 'audio' :
                 m.document ? 'document' : m.sticker ? 'sticker' :
                 m.location ? 'location' : m.contact ? 'contact' :
                 m.reaction ? 'reaction' : m.message ? 'text' : 'unknown';
    return [{
      externalId: String(m.id ?? m.message_id ?? ts),
      from,
      to,
      type,
      content: {
        text: m.message ?? undefined,
        media: m.image || m.video || m.audio || m.document
          ? { url: m.image?.url ?? m.video?.url ?? m.audio?.url ?? m.document?.url,
              mime: m.image?.mime_type ?? m.video?.mime_type,
              filename: m.document?.filename }
          : undefined,
        reaction: m.reaction?.emoji,
        replyToMessageId: m.context?.id ?? m.context?.message_id,
      },
      receivedAt: new Date(ts * (ts < 1e12 ? 1000 : 1)),
      rawPayload: raw,
    }];
  }

  normalizeStatus(_account: AccountConfig, raw: unknown): CanonicalStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const r: any = raw;
    if (r.event && r.event !== 'message_status') return null;
    const s: any = r.payload ?? r;
    const statusName = (s?.status ?? '').toString();
    const allowed: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
      pending: 'sent',
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      failed: 'failed',
      'read-self': 'read',
    };
    const status = allowed[statusName];
    if (!status) return null;
    const ts = Number(s?.timestamp ?? Date.now());
    return {
      externalId: String(s?.message_id ?? s?.id ?? ''),
      status,
      updatedAt: new Date(ts * (ts < 1e12 ? 1000 : 1)),
      error: status === 'failed'
        ? { code: 'GWMD_FAILED', message: JSON.stringify(s?.errors ?? []), retryable: false }
        : undefined,
      rawPayload: raw,
    };
  }

  // ─── Provisioning (TZ §1038) — gwmd QR pairing per device ─────────────

  /**
   * Wizard entry point — POST /devices (create), then GET /devices/:id/login (mint QR).
   *
   * gwmd's `device_id` is caller-supplied (no server-side id generation), so we
   * reuse the wizard's `deviceName` input as the device_id. The phone comes
   * BACK from the sidecar after the QR scan, but for gwmd we *do* require an
   * initial phone to seed `device_id` since gwmd's auth/pairing is tied to a
   * specific session key generated at create time.
   */
  async provisionQr(
    account: AccountConfig,
    input: ProvisionQrInput,
  ): Promise<ProvisionQrResult> {
    const deviceId = String(input.deviceName ?? '').trim();
    if (!deviceId) {
      throw new ProvisioningError(
        'phoneE164 is required for gwmd (used as device_id)',
        'INVALID_INPUT',
        false,
      );
    }

    // Step 1: create the device session (idempotent — gwmd returns the
    // existing device when the id is already known).
    const createUrl = `${this.baseUrl(account)}/app/devices`;
    let createRes: Response;
    try {
      createRes = await fetch(createUrl, {
        method: 'POST',
        headers: this.authHeaders(account),
        body: JSON.stringify({ device_id: deviceId }),
      });
    } catch (e: any) {
      throw new ProvisioningError(
        `gwmd create device network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    const createBody: any = await createRes.json().catch(() => ({}));
    if (!createRes.ok) {
      throw new ProvisioningError(
        `gwmd create device returned ${createRes.status}`,
        createRes.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        createRes.status >= 500,
        createBody,
      );
    }

    // Step 2: ask the sidecar to mint a fresh login QR.
    const loginUrl = `${this.baseUrl(account)}/app/devices/${encodeURIComponent(deviceId)}/login`;
    let loginRes: Response;
    try {
      loginRes = await fetch(loginUrl, { method: 'GET', headers: this.authHeaders(account) });
    } catch (e: any) {
      throw new ProvisioningError(
        `gwmd login network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    const loginBody: any = await loginRes.json().catch(() => ({}));
    if (!loginRes.ok) {
      throw new ProvisioningError(
        `gwmd login returned ${loginRes.status}`,
        loginRes.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        loginRes.status >= 500,
        loginBody,
      );
    }
    const results = loginBody?.results ?? loginBody?.data ?? {};
    const qrLink = String(results.qr_link ?? results.qr_url ?? '');
    if (!qrLink) {
      throw new ProvisioningError(
        'gwmd login response missing qr_link',
        'BAD_RESPONSE',
        false,
        loginBody,
      );
    }
    return {
      sessionId: String(results.device_id ?? deviceId),
      // gwmd returns a URL (not a base64 payload), so the web UI fetches
      // it as an image. We still store it in `uri` for the wizard's
      // debug panel and any future image-proxy logic.
      uri: qrLink,
      ttlSeconds: Number(results.qr_duration ?? 60),
    };
  }

  /**
   * `GET /devices` — list devices known to this gwmd sidecar.
   * Paired status comes from `is_logged_in` (we re-read each device's status
   * to keep this list cheap; gwmd's /devices returns lightweight metadata).
   */
  async listProvisionedAccounts(account: AccountConfig): Promise<ProvisionedAccount[]> {
    const url = `${this.baseUrl(account)}/app/devices`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: this.authHeaders(account) });
    } catch (e: any) {
      throw new ProvisioningError(
        `gwmd list devices network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    if (!res.ok) {
      throw new ProvisioningError(
        `gwmd list devices returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
      );
    }
    const body: any = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(body) ? body
      : Array.isArray(body?.results) ? body.results
      : Array.isArray(body?.data) ? body.data
      : [];
    return list.map((d: any) => {
      // gwmd's /devices list returns the per-device record built by
      // `deriveState`: ID (== device_id), JID, State ∈ {Connected,
      // LoggedIn, Disconnected}, PhoneNumber, DisplayName, CreatedAt.
      // We surface device_id as externalId (gwmd treats it as the
      // DELETE/GET /:id key), JID-derived E.164 as phoneE164, and the
      // device_id again as deviceName so the poll matcher can pick the
      // wizard's row back out via deviceName fallback.
      const deviceId = String(d?.ID ?? d?.device_id ?? d?.id ?? '');
      const jid = d?.JID ?? d?.jid ?? '';
      return {
        externalId: deviceId,
        phoneE164: jid ? jidToPhone(jid) : (d?.PhoneNumber ?? d?.phone ?? null),
        uuid: null,
        deviceName: deviceId,
        raw: d,
      };
    });
  }

  /** `DELETE /devices/:device_id` — log out (paired credentials kept on disk). */
  async unlink(account: AccountConfig, externalId: string): Promise<void> {
    const url = `${this.baseUrl(account)}/app/devices/${encodeURIComponent(externalId)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'DELETE', headers: this.authHeaders(account) });
    } catch (e: any) {
      throw new ProvisioningError(
        `gwmd unlink network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    if (!res.ok && res.status !== 404) {
      throw new ProvisioningError(
        `gwmd unlink returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
      );
    }
  }
}

/** Convert a WhatsApp JID like "1234567890:12@s.whatsapp.net" → "+1234567890". */
function jidToPhone(jid: string): string | null {
  const m = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/.exec(String(jid));
  return m ? `+${m[1]}` : null;
}
