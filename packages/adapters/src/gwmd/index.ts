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
 * — which doesn't fit our wizard-driven QR flow. gwmd returns a JSON
 * envelope `{ qr_link, qr_duration, device_id }` from
 * `GET /devices/:device_id/login`, where `qr_link` is a URL the sidecar
 * itself serves as a PNG.
 *
 * That URL is built from the request's Host header and therefore names the
 * sidecar on the internal `transports` network, which the admin's browser
 * cannot reach. `fetchProvisioningImage` below pulls the bytes API-side and
 * `GET /api/v1/transport-accounts/:id/provision/:endpointId/qr.png` streams
 * them out.
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
 * NOTE: gwmd mounts its REST under a configurable base path; the service
 * runs with `--base-path=/app` (named `--app-base-path` on the development
 * branch) and we hardcode `/app` here. Change one and you must change both.
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
    // gwmd's send routes are device-agnostic: the device is picked by the
    // `X-Device-Id` header (middleware/device.go), NOT by a path segment.
    // The media kind selects the route — text, image and file are separate.
    const media = outbound.content.media;
    const route = !media ? 'message'
      : media.mime?.startsWith('image/') ? 'image'
      : media.mime?.startsWith('video/') ? 'video'
      : media.mime?.startsWith('audio/') ? 'audio'
      : 'file';
    const url = `${this.baseUrl(account)}/app/send/${route}`;
    const recipient = outbound.to[0]?.e164 ?? outbound.to[0]?.raw ?? '';
    const payload: Record<string, unknown> = {
      phone: recipient.replace(/^\+/, ''),
      message: outbound.content.text ?? '',
    };
    if (outbound.content.replyToMessageId) {
      payload['reply_message_id'] = outbound.content.replyToMessageId;
    }
    if (media?.url) {
      // Media routes take a remote URL under a per-route field and carry the
      // accompanying text as `caption`.
      payload[route === 'file' ? 'file_url' : `${route}_url`] = media.url;
      payload['caption'] = outbound.content.text ?? '';
    }
    if (outbound.content.reaction) {
      payload['reaction'] = outbound.content.reaction;
      payload['message_id'] = outbound.content.replyToMessageId;
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        // gwmd runs url.QueryUnescape over X-Device-Id (middleware/device.go),
        // so the value has to be encoded to survive intact. Legacy endpoints
        // whose id literally contains "%2B" only resolve this way.
        headers: { ...this.authHeaders(account), 'x-device-id': encodeURIComponent(deviceId) },
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
  normalizeInbound(_account: AccountConfig, endpoint: EndpointConfig, raw: unknown): CanonicalInbound[] {
    if (!raw || typeof raw !== 'object') return [];
    const outer: any = raw;
    // The delivered envelope nests the message under `payload`, with routing
    // fields alongside it:
    //   { event, device_id, session_id, payload: { … } }
    // Verified against a live delivery; some builds post the message fields
    // flat, so fall back to the outer object.
    const m: any = outer.payload ?? outer;
    // Fields inside `payload` that matter here:
    //   id           WhatsApp message id
    //   timestamp    RFC3339 string (NOT epoch)
    //   from         sender JID, e.g. "380671476395@s.whatsapp.net"
    //   from_name    pushname
    //   body         the message text (NOT `message`)
    //   image/video/audio/document/sticker  media descriptors
    //   is_from_me   true for our own outgoing messages, echoed back
    if (outer.event && outer.event !== 'message' && outer.event !== 'message.reaction') return [];
    // Our own outbound messages come back over the same webhook; ingesting
    // them would double-count every reply we send.
    if (m.is_from_me === true) return [];

    const hasMedia = !!(m.image || m.video || m.audio || m.document || m.sticker || m.video_note);
    if (!m.body && !hasMedia && !m.reaction) return [];

    // `timestamp` is RFC3339; Date.parse handles it. Fall back to now() only
    // when the field is missing or unparseable.
    const parsed = m.timestamp ? Date.parse(String(m.timestamp)) : NaN;
    const receivedAt = Number.isNaN(parsed) ? new Date() : new Date(parsed);

    const from = makeAddress(jidToPhone(String(m.from ?? '')) ?? String(m.from ?? ''));
    const to = [makeAddress(String(endpoint.phoneE164 ?? endpoint.externalId ?? ''))];
    const media = m.image ?? m.video ?? m.audio ?? m.document ?? m.sticker ?? m.video_note;
    const type: CanonicalInbound['type'] =
      m.reaction ? 'reaction' :
      m.image ? 'image' :
      m.video || m.video_note ? 'video' :
      m.audio ? 'audio' :
      m.document ? 'document' :
      m.sticker ? 'sticker' :
      m.body ? 'text' : 'unknown';

    return [{
      externalId: String(m.id ?? ''),
      from,
      to,
      type,
      content: {
        text: m.body ?? undefined,
        // Media descriptors are either a bare path string (auto-download on)
        // or an object carrying url/mime/filename.
        media: hasMedia
          ? {
              url: typeof media === 'string' ? media : (media?.url ?? media?.media_path),
              mime: typeof media === 'string' ? undefined : media?.mime_type,
              filename: typeof media === 'string' ? undefined : media?.file_name,
            }
          : undefined,
        reaction: typeof m.reaction === 'string' ? m.reaction : m.reaction?.emoji,
        replyToMessageId: m.replied_to_id ?? m.reacted_message_id,
        meta: {
          senderName: m.from_name ?? null,
          chatId: m.chat_id ?? null,
          sessionId: m.session_id ?? null,
        },
      },
      receivedAt,
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
    const requested = String(input.deviceName ?? '').trim();
    if (!requested) {
      throw new ProvisioningError(
        'phoneE164 is required for gwmd (used as device_id)',
        'INVALID_INPUT',
        false,
      );
    }
    // Strip everything but digits. gwmd takes the id from a JSON body on
    // create but from a URL path segment on login, and Fiber does not decode
    // path params — so a "+" prefix produced TWO devices ("+380..." and
    // "%2B380..."), with the QR pairing landing on one and sends addressing
    // the other. An id with nothing to escape keeps both paths identical.
    const deviceId = requested.replace(/\D/g, '') || requested;

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
      // gwmd renders the QR itself and returns a URL built from the request
      // Host — e.g. `http://gwmd:3000/app/statics/…`. That host only exists
      // on the internal `transports` network, so the API proxies the image
      // rather than passing this URL to the browser.
      uri: qrLink,
      imageUrl: qrLink,
      ttlSeconds: Number(results.qr_duration ?? 60),
    };
  }

  /**
   * Pull the rendered QR PNG off the sidecar so the API can stream it to the
   * admin's browser. gwmd puts the image behind the same basic auth as the
   * REST surface, so we reuse the account credentials.
   */
  async fetchProvisioningImage(
    account: AccountConfig,
    imageUrl: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    // `imageUrl` comes from a vendor response, so treat it as untrusted:
    // accept it only if it names the configured sidecar host, then fetch it
    // from our own base URL rather than the vendor's string. gwmd builds the
    // URL from the request Host header and drops the port, so the raw value
    // would resolve to port 80 and never answer.
    let target: URL;
    let allowed: URL;
    try {
      target = new URL(imageUrl);
      allowed = new URL(this.baseUrl(account));
    } catch {
      throw new ProvisioningError('gwmd QR image URL is malformed', 'BAD_RESPONSE', false);
    }
    if (target.hostname !== allowed.hostname) {
      throw new ProvisioningError(
        `gwmd QR image URL points outside the sidecar (${target.hostname})`,
        'BAD_RESPONSE',
        false,
      );
    }
    const fetchUrl = new URL(target.pathname + target.search, allowed.origin);

    let res: Response;
    try {
      res = await fetch(fetchUrl.toString(), {
        method: 'GET',
        headers: this.authHeader(account) ? { authorization: this.authHeader(account)! } : {},
      });
    } catch (e: any) {
      throw new ProvisioningError(
        `gwmd QR image network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    if (!res.ok) {
      throw new ProvisioningError(
        `gwmd QR image returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
      );
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'image/png',
    };
  }

  /**
   * `GET /devices` — devices known to this gwmd sidecar that are actually
   * paired.
   *
   * The wizard creates the device row *before* rendering the QR, so an
   * unfiltered list would contain the pending device and the API's poll
   * would declare it linked the instant it started. Only `state ==
   * "logged_in"` (or a non-empty JID) means a phone completed the scan.
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
    return list
      // gwmd's /devices record (domains/device.Device): id, phone_number,
      // display_name, state ∈ {disconnected, connecting, connected,
      // logged_in}, jid, created_at. The dev stub mirrors it with
      // capitalised keys, so read both.
      .filter((d: any) => {
        const state = String(d?.state ?? d?.State ?? '').toLowerCase();
        const jid = String(d?.jid ?? d?.JID ?? '');
        return state === 'logged_in' || state === 'loggedin' || jid !== '';
      })
      .map((d: any) => {
        // device_id is externalId (gwmd's DELETE/GET /:id key); the
        // JID-derived E.164 is the phone; device_id doubles as deviceName so
        // the poll matcher can find the wizard's row.
        const deviceId = String(d?.ID ?? d?.device_id ?? d?.id ?? '');
        const jid = d?.JID ?? d?.jid ?? '';
        return {
          externalId: deviceId,
          phoneE164: jid ? jidToPhone(jid) : (d?.phone_number ?? d?.PhoneNumber ?? d?.phone ?? null),
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
