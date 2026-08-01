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
 * Adapter for UnoAPI Cloud (https://github.com/clairton/unoapi-cloud).
 * Sidecar is a Node service wrapping Baileys; session data lives on a
 * per-account volume.
 *
 * The UnoAPI HTTP shape mirrors WhatsApp Cloud API
 * (https://developers.facebook.com/docs/whatsapp/cloud-api), so payloads
 * follow the `messaging_product: "whatsapp"` envelope (TZ §23).
 *
 * Required config (`account.configJson`):
 *   baseUrl: e.g. "http://unoapi:9876"
 *   apiKey:  UnoAPI auth token (set on `/session/{phone}`)
 *
 * Mapping:
 *   Endpoint.externalId   -> phone number (used as `phone` path param)
 *   Endpoint.phoneE164     -> canonical phone (also used as `phone`)
 *   Endpoint.configJson.broadcastGroups -> "yes" | "no" for group messages
 */
export class UnoApiAdapter {
  readonly name = 'unoapi';

  private baseUrl(account: AccountConfig): string {
    const base = (account.configJson.baseUrl ?? '').toString().replace(/\/$/, '');
    if (!base) throw new Error('unoapi: account.configJson.baseUrl is required');
    return base;
  }

  private apiKey(account: AccountConfig): string {
    const key = (account.configJson.apiKey ?? '').toString();
    if (!key) throw new Error('unoapi: account.configJson.apiKey is required');
    return key;
  }

  private endpointPhone(endpoint: EndpointConfig): string {
    const phone = endpoint.phoneE164 ?? endpoint.externalId ?? '';
    if (!phone) throw new Error('unoapi: endpoint missing phoneE164/externalId');
    return phone.replace(/^\+/, '');
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
        // TZ §1038 — UnoAPI exposes a per-phone QR pairing flow.
        provisioning: 'qr',
      },
    };
  }

  async healthCheck(account: AccountConfig): Promise<AdapterHealth> {
    const url = `${this.baseUrl(account)}/ping`;
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'GET' });
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

  /** Build a Cloud-API-shaped payload from a canonical outbound. */
  private buildCloudApiPayload(outbound: CanonicalOutbound): Record<string, unknown> {
    const phone = outbound.to[0]?.e164 ?? outbound.to[0]?.raw ?? '';
    const base: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: phone.replace(/^\+/, ''),
    };
    if (outbound.type === 'text') {
      base.type = 'text';
      base.text = { body: outbound.content.text ?? '' };
    } else if (outbound.type === 'image' || outbound.type === 'video' || outbound.type === 'audio' || outbound.type === 'document' || outbound.type === 'sticker') {
      const mt = outbound.type === 'sticker' ? 'sticker' : outbound.type;
      base.type = mt;
      // UnoAPI accepts media links via `link`.
      base[mt] = {
        link: outbound.content.media?.url,
        caption: outbound.content.text ?? undefined,
      };
    } else if (outbound.type === 'location') {
      base.type = 'location';
      base.location = outbound.content.meta?.['location'] ?? {};
    } else if (outbound.type === 'contact') {
      base.type = 'contacts';
      base.contacts = outbound.content.meta?.['contacts'] ?? [];
    } else if (outbound.type === 'reaction') {
      base.type = 'reaction';
      base.reaction = {
        message_id: outbound.content.replyToMessageId,
        emoji: outbound.content.reaction,
      };
    } else {
      // Fallback — treat as text so we don't silently lose the message.
      base.type = 'text';
      base.text = { body: outbound.content.text ?? '' };
    }
    return base;
  }

  async send(
    outbound: CanonicalOutbound,
    endpoint: EndpointConfig,
    account: AccountConfig,
  ): Promise<SendResult> {
    const phone = this.endpointPhone(endpoint);
    const url = `${this.baseUrl(account)}/v15.0/${phone}/messages`;
    const payload = this.buildCloudApiPayload(outbound);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.apiKey(account),
        },
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
            code: raw?.error?.code ?? `HTTP_${res.status}`,
            message: raw?.error?.message ?? JSON.stringify(raw),
            retryable,
          },
        };
      }
      const externalId: string | null = raw?.messages?.[0]?.id ?? null;
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

  /** Receipts + delivery updates — UnoAPI sends these via webhook, see
   *  `docs/licensing/third-party.md` and `docs/runbooks/whatsapp-reconnect.md`.
   */
  normalizeStatus(_account: AccountConfig, raw: unknown): CanonicalStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const r: any = raw;
    const ev = r.entry?.[0]?.changes?.[0]?.value;
    if (!ev) return null;
    const statuses = ev.statuses ?? [];
    if (statuses.length === 0) return null;
    const s = statuses[0];
    const externalId: string = s?.id ?? '';
    const statusName = (s?.status ?? '').toString();
    const allowed: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      failed: 'failed',
    };
    const status = allowed[statusName] ?? 'unknown';
    return {
      externalId,
      status,
      updatedAt: new Date(Number(s?.timestamp ?? Date.now()) * 1000),
      error: status === 'failed'
        ? { code: 'WA_FAILED', message: JSON.stringify(s?.errors ?? []), retryable: false }
        : undefined,
      rawPayload: raw,
    };
  }

  /** Inbound messages — UnoAPI Cloud forwards them as `messages` entries. */
  normalizeInbound(_account: AccountConfig, _endpoint: EndpointConfig, raw: unknown): CanonicalInbound[] {
    if (!raw || typeof raw !== 'object') return [];
    const r: any = raw;
    const ev = r.entry?.[0]?.changes?.[0]?.value;
    if (!ev || !Array.isArray(ev.messages)) return [];
    const phoneNumberId = ev.metadata?.phone_number_id ?? _endpoint.externalId ?? _endpoint.phoneE164;

    return ev.messages.map((m: any): CanonicalInbound => ({
      externalId: String(m.id ?? ''),
      from: makeAddress(String(m.from ?? '')),
      to: [makeAddress(String(phoneNumberId ?? ''))],
      type: mapWaTypeToCanonical(m.type),
      content: {
        text: m.text?.body ?? undefined,
        media: m.image || m.video || m.audio || m.document
          ? { url: m.image?.link ?? m.video?.link ?? m.audio?.link ?? m.document?.link, mime: m.image?.mime_type, filename: m.document?.filename }
          : undefined,
        reaction: m.reaction?.emoji,
        replyToMessageId: m.context?.id,
      },
      receivedAt: new Date(Number(m.timestamp ?? Date.now()) * 1000),
      rawPayload: m,
    }));
  }

  // ─── Provisioning (TZ §1038) — UnoAPI per-phone QR pairing ───────────

  /**
   * UnoAPI provisioning — `GET /session/{phone}/qr`.
   *
   * Unlike Signal, UnoAPI requires the phone number up front (sessions are
   * per-phone). The wizard in the web UI surfaces a phone input when the
   * admin clicks "Прив'язати" on a WhatsApp channel.
   */
  async provisionQr(
    account: AccountConfig,
    input: ProvisionQrInput,
  ): Promise<ProvisionQrResult> {
    const phone = String(input.deviceName ?? '').trim();
    if (!phone) {
      throw new ProvisioningError(
        'phoneE164 is required for UnoAPI',
        'INVALID_INPUT',
        false,
      );
    }
    const normalized = phone.replace(/^\+/, '');
    const url = `${this.baseUrl(account)}/session/${encodeURIComponent(normalized)}/qr`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch (e: any) {
      throw new ProvisioningError(
        `unoapi qr network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body?.qr) {
      throw new ProvisioningError(
        `unoapi qr returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
        body,
      );
    }
    return {
      sessionId: normalized,
      uri: String(body.qr),
      ttlSeconds: Number(body.expires_in ?? 120),
    };
  }

  /** `GET /admin/sessions` — list phones already paired with this UnoAPI node. */
  async listProvisionedAccounts(account: AccountConfig): Promise<ProvisionedAccount[]> {
    const url = `${this.baseUrl(account)}/admin/sessions`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch (e: any) {
      throw new ProvisioningError(
        `unoapi list sessions network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    if (!res.ok) {
      throw new ProvisioningError(
        `unoapi list sessions returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
      );
    }
    const body: any = await res.json().catch(() => []);
    const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.sessions) ? body.sessions : [];
    return list.map((s: any) => {
      const phone = String(s?.phone ?? s?.id ?? '');
      return {
        externalId: phone,
        phoneE164: phone ? `+${phone.replace(/^\+/, '')}` : null,
        uuid: null,
        deviceName: phone,
        raw: s,
      };
    });
  }

  /** `DELETE /session/{phone}` — drop a paired UnoAPI session. */
  async unlink(account: AccountConfig, externalId: string): Promise<void> {
    const phone = externalId.replace(/^\+/, '');
    const url = `${this.baseUrl(account)}/session/${encodeURIComponent(phone)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'DELETE' });
    } catch (e: any) {
      throw new ProvisioningError(
        `unoapi unlink network error: ${e?.message ?? e}`,
        'TRANSPORT_ERROR',
        true,
      );
    }
    if (!res.ok && res.status !== 404) {
      throw new ProvisioningError(
        `unoapi unlink returned ${res.status}`,
        res.status >= 500 ? 'TRANSPORT_ERROR' : 'BAD_RESPONSE',
        res.status >= 500,
      );
    }
  }
}

function mapWaTypeToCanonical(t: string | undefined): CanonicalInbound['type'] {
  switch ((t ?? '').toLowerCase()) {
    case 'text': return 'text';
    case 'image': return 'image';
    case 'audio': return 'audio';
    case 'ptt': return 'voice';
    case 'video': return 'video';
    case 'document': return 'document';
    case 'sticker': return 'sticker';
    case 'location': return 'location';
    case 'contacts': return 'contact';
    case 'reaction': return 'reaction';
    case 'interactive': return 'interactive';
    case 'button':
    case 'system':
      return 'system';
    default:
      return 'unknown';
  }
}
