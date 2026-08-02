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
 * Adapter for the DBLtek GoIP SMS Server (TZ §21, ADR-003).
 *
 * The SMS Server is a LAMP application that sits between UMG and the GSM
 * hardware. Its third-party interface is JSON over HTTP POST:
 *
 *   POST /goip/sendsms/     { auth, number, content, goip_line?, provider? }
 *   POST /goip/querysms/    { auth, taskID }
 *   POST /goip/querylines/  { auth }
 *
 * Three details that are easy to get wrong:
 *   - every request carries `auth`; without it the server answers 401;
 *   - the trailing slash on the path is mandatory;
 *   - recipient numbers are bare, without a leading "+".
 *
 * Credentials are per *account*, not per SIM. Each SIM's own IP/ID/password is
 * configured on the GSM gateway itself and mirrored in the SMS Server's "GoIP
 * Manage" screen — that pairing is between the hardware and the server, and
 * UMG never sees it. Here a SIM is addressed by its line id ("G101", "G102", …)
 * which we keep on the endpoint.
 *
 * Required per-account `configJson`:
 *   { "baseUrl": "http://dbsms-server", "username": "...", "password": "..." }
 *
 * Required per-endpoint: `externalId` — the GoIP line id, e.g. "G101".
 *
 * Inbound SMS and delivery reports are not polled: the SMS Server POSTs them to
 * URLs configured in its own System Settings. `normalizeInbound` and
 * `normalizeStatus` below parse those payloads.
 */
export class GoipVendorAdapter {
  readonly name = 'goip-vendor';

  private baseUrl(account: AccountConfig): string {
    const base = (account.configJson.baseUrl ?? '').toString().replace(/\/$/, '');
    if (!base) throw new Error('goip-vendor: account.configJson.baseUrl is required');
    return base;
  }

  private auth(account: AccountConfig): { username: string; password: string } {
    const username = (account.configJson.username ?? '').toString();
    const password = (account.configJson.password ?? '').toString();
    if (!username || !password) {
      throw new Error('goip-vendor: account.configJson.username/password are required');
    }
    return { username, password };
  }

  /** GoIP line id, e.g. "G101". Optional: without it the server round-robins. */
  private lineId(endpoint: EndpointConfig): string | null {
    const raw =
      endpoint.externalId ||
      (endpoint.configJson?.['goipLine'] ?? endpoint.configJson?.['lineId'] ?? '');
    const id = String(raw).trim();
    return id || null;
  }

  /** Every call is a POST with an `auth` object; the trailing slash matters. */
  private async call(
    account: AccountConfig,
    command: 'sendsms' | 'querysms' | 'querylines',
    body: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; status: number; data: any }> {
    const url = `${this.baseUrl(account)}/goip/${command}/`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: this.auth(account), ...body }),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
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
        media: false,
        // SIMs are physical and pre-installed; there is nothing to pair.
        provisioning: 'none',
      },
    };
  }

  async healthCheck(account: AccountConfig): Promise<AdapterHealth> {
    const t0 = Date.now();
    try {
      const { ok, status, data } = await this.call(account, 'querylines');
      const lines = Array.isArray(data) ? data : [];
      // A line is only usable when the gateway is connected to the SMS Server
      // *and* the SIM has registered with the carrier.
      const usable = lines.filter(
        (l: any) => String(l?.online) === '1' && String(l?.reg).toUpperCase() === 'LOGIN',
      ).length;
      return {
        ok: ok && lines.length > 0 && usable > 0,
        details: {
          httpStatus: status,
          latencyMs: Date.now() - t0,
          lines: lines.length,
          usableLines: usable,
          // 401 here means the SMS Server credentials are wrong, which is a
          // different problem from the gateway being unplugged.
          ...(status === 401 ? { error: 'SMS Server rejected the credentials' } : {}),
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
    // The server takes bare numbers; a leading "+" is treated as part of the
    // number and the send fails with no useful diagnostic.
    const recipient = (outbound.to[0]?.e164 ?? outbound.to[0]?.raw ?? '').replace(/[^\d]/g, '');
    if (!recipient) {
      return {
        externalId: null,
        accepted: false,
        rawResponse: null,
        error: {
          code: 'NO_RECIPIENT',
          message: 'no recipient after normalisation',
          retryable: false,
        },
      };
    }
    const text = outbound.content.text ?? '';
    if (!text) {
      return {
        externalId: null,
        accepted: false,
        rawResponse: null,
        error: { code: 'EMPTY_BODY', message: 'SMS requires a text body', retryable: false },
      };
    }

    const body: Record<string, unknown> = { number: recipient, content: text };
    const line = this.lineId(endpoint);
    if (line) body.goip_line = line;

    try {
      const { ok, status, data } = await this.call(account, 'sendsms', body);
      if (status === 401) {
        return {
          externalId: null,
          accepted: false,
          rawResponse: data,
          error: {
            code: 'AUTH_FAILED',
            message: 'SMS Server rejected the credentials',
            retryable: false,
          },
        };
      }
      if (!ok || !data) {
        return {
          externalId: null,
          accepted: false,
          rawResponse: data,
          error: {
            code: `HTTP_${status}`,
            message: `SMS Server returned ${status}`,
            retryable: status >= 500,
          },
        };
      }
      if (String(data.result).toUpperCase() !== 'ACCEPT') {
        const reason = String(data.reason ?? 'unknown');
        return {
          externalId: null,
          accepted: false,
          rawResponse: data,
          error: {
            code: rejectCode(reason),
            message: rejectMessage(reason),
            // "no usable line" is a transient hardware state — the SIM may
            // re-register — while an unknown provider is a config error.
            retryable: reason === 'none_line',
          },
        };
      }
      // A task can fan out to many recipients, so the server keys status by
      // "<taskID>.<number>". We send one recipient at a time, which makes that
      // composite the stable id for querysms and for the delivery callback.
      const taskId = String(data.taskID ?? '');
      return {
        externalId: taskId ? `${taskId}.${recipient}` : null,
        accepted: true,
        rawResponse: data,
      };
    } catch (e: any) {
      return {
        externalId: null,
        accepted: false,
        rawResponse: null,
        error: { code: 'NETWORK_ERROR', message: e?.message ?? String(e), retryable: true },
      };
    }
  }

  /**
   * Delivery reports arrive as `{ taskID, goip_line, send, err_code?, receipt? }`,
   * either pushed to the status URL configured in the SMS Server or returned
   * from `querysms`. Both shapes are identical, so one parser covers both.
   */
  normalizeStatus(_account: AccountConfig, raw: unknown): CanonicalStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const r: any = raw;
    const externalId = String(r.taskID ?? '');
    const sendState = String(r.send ?? '').toLowerCase();
    if (!externalId || !sendState) return null;

    // `unsend` means the server has not attempted delivery yet. There is no
    // canonical status for that, and forcing it to `unknown` would overwrite a
    // more accurate local state — so report nothing and leave the message be.
    const mapped: Record<string, CanonicalStatus['status']> = {
      succeeded: 'sent',
      failed: 'failed',
      sending: 'sent',
    };
    let status = mapped[sendState];
    if (!status) return null;
    // `receipt: 1` is the carrier confirming the handset received it, which is
    // a stronger statement than "the gateway sent it".
    if (status === 'sent' && String(r.receipt ?? '') === '1') status = 'delivered';

    const errCode = r.err_code ? String(r.err_code) : null;
    return {
      externalId,
      status,
      updatedAt: new Date(),
      error:
        status === 'failed'
          ? {
              code: errCode ? `CMS_${errCode}` : 'SMS_FAILED',
              message: errCode ? cmsErrorText(errCode) : 'SMS Server reported a failure',
              retryable: errCode ? RETRYABLE_CMS_ERRORS.has(errCode) : false,
            }
          : undefined,
      rawPayload: raw,
    };
  }

  /**
   * Inbound SMS, POSTed by the SMS Server to the forwarding URL set in its
   * System Settings: `{ goip_line, from_number, content, recv_time }`.
   */
  normalizeInbound(
    _account: AccountConfig,
    endpoint: EndpointConfig,
    raw: unknown,
  ): CanonicalInbound[] {
    if (!raw || typeof raw !== 'object') return [];
    const r: any = raw;
    const from = String(r.from_number ?? '').trim();
    const text = String(r.content ?? '');
    if (!from || !text) return [];

    // "YYYY-MM-DD hh:mm:ss" in the server's local timezone. A space-separated
    // stamp parses inconsistently across engines, so normalise the separator.
    const parsed = r.recv_time ? Date.parse(String(r.recv_time).replace(' ', 'T')) : NaN;
    const receivedAt = Number.isNaN(parsed) ? new Date() : new Date(parsed);

    return [
      {
        // The vendor gives inbound messages no id, so key on line, sender and
        // timestamp — a replayed message then produces the same id and is
        // deduplicated upstream.
        externalId: `${r.goip_line ?? 'line'}:${from}:${receivedAt.getTime()}`,
        from: makeAddress(from),
        to: [makeAddress(String(endpoint.phoneE164 ?? endpoint.externalId ?? ''))],
        type: 'text',
        content: { text, meta: { goipLine: r.goip_line ?? null } },
        receivedAt,
        rawPayload: raw,
      },
    ];
  }

  /** `querylines` — which SIMs the gateway currently has, and their state. */
  async listLines(
    account: AccountConfig,
  ): Promise<
    Array<{ line: string; online: boolean; registered: boolean; remainingSms: number | null }>
  > {
    const { data } = await this.call(account, 'querylines');
    if (!Array.isArray(data)) return [];
    return data.map((l: any) => ({
      line: String(l?.goip_line ?? ''),
      online: String(l?.online) === '1',
      registered: String(l?.reg).toUpperCase() === 'LOGIN',
      // "-1" is the vendor's way of saying "no limit".
      remainingSms:
        l?.remain_sms === undefined || String(l.remain_sms) === '-1' ? null : Number(l.remain_sms),
    }));
  }

  /**
   * Sends a USSD code from a specific SIM and returns the carrier's reply.
   *
   * This is the only way to read a prepaid balance: the SMS Server's own
   * "Auto balance and recharge" scheme keeps `goip.bal` up to date, but it is
   * configured in the vendor UI and exposed through no API. A USSD round-trip
   * needs no configuration at all — the caller supplies the carrier's code.
   *
   * Unlike the JSON commands this is a GET on `en/ussd.php`, with credentials
   * in the query string and the reply as plain text prefixed by "OK ".
   */
  async sendUssd(
    account: AccountConfig,
    line: string,
    code: string,
  ): Promise<{ ok: boolean; reply: string }> {
    const { username, password } = this.auth(account);
    const url =
      `${this.baseUrl(account)}/goip/en/ussd.php` +
      `?USERNAME=${encodeURIComponent(username)}` +
      `&PASSWORD=${encodeURIComponent(password)}` +
      `&TERMID=${encodeURIComponent(line)}` +
      // "*" and "#" must be percent-encoded or the query string swallows them.
      `&USSDMSG=${encodeURIComponent(code)}`;

    const res = await fetch(url, { method: 'GET' });
    const text = (await res.text()).trim();
    if (!res.ok) {
      return { ok: false, reply: `SMS Server returned ${res.status}` };
    }
    // Errors come back as plain text too, e.g. "ERROR Not find this TERM".
    if (/^ERROR/i.test(text)) {
      return { ok: false, reply: text };
    }
    return { ok: true, reply: text.replace(/^OK\s*/i, '') };
  }

  /**
   * Reads a prepaid balance by USSD and pulls the amount out of the reply.
   *
   * Carriers answer in free-form text, so the amount is extracted heuristically
   * and the raw reply is always returned alongside — an operator can read
   * "Na rahunku 106.0 grn." even when no parser recognises it.
   */
  async checkBalance(
    account: AccountConfig,
    line: string,
    ussdCode: string,
  ): Promise<{ ok: boolean; amount: number | null; currency: string | null; reply: string }> {
    const { ok, reply } = await this.sendUssd(account, line, ussdCode);
    if (!ok) return { ok: false, amount: null, currency: null, reply };

    // First number with an optional decimal part, plus a currency word if the
    // carrier put one next to it.
    const m = /(-?\d+(?:[.,]\d{1,2})?)\s*(grn|грн|uah|₴|usd|eur)?/i.exec(reply);
    return {
      ok: true,
      amount: m ? Number(m[1].replace(',', '.')) : null,
      currency: m?.[2] ? m[2].toLowerCase() : null,
      reply,
    };
  }

  /** `querysms` — pull the current state of a previously accepted send. */
  async queryStatus(account: AccountConfig, externalId: string): Promise<CanonicalStatus | null> {
    const { data } = await this.call(account, 'querysms', { taskID: externalId });
    if (!Array.isArray(data) || data.length === 0) return null;
    return this.normalizeStatus(account, data[0]);
  }
}

function rejectCode(reason: string): string {
  switch (reason) {
    case 'none_line':
      return 'NO_USABLE_LINE';
    case 'none_provider':
      return 'UNKNOWN_PROVIDER';
    default:
      return 'SEND_REJECTED';
  }
}

function rejectMessage(reason: string): string {
  switch (reason) {
    case 'none_line':
      return 'Немає доступної лінії: SIM не зареєстрована в мережі або SMS вимкнено';
    case 'none_provider':
      return 'Оператора з такою назвою не налаштовано в SMS-сервері';
    default:
      return `SMS-сервер відхилив запит: ${reason}`;
  }
}

/**
 * GSM failures that may succeed on a later attempt. Everything else in the CMS
 * error table describes a permanent condition — a barred or unassigned number,
 * an unsupported message type — where retrying only burns SIM credit.
 */
const RETRYABLE_CMS_ERRORS = new Set([
  '17', // Network failure
  '38', // Network out of order
  '41', // Temporary failure
  '42', // Congestion
  '47', // Resources unavailable
  '192', // SC busy
  '194', // SC system failure
  '331', // no network service
  '332', // network timeout
]);

/** A few codes worth naming; the rest surface as-is for the operator to look up. */
const CMS_ERRORS: Record<string, string> = {
  '1': 'Номер не існує',
  '8': 'Заблоковано оператором',
  '17': 'Збій мережі',
  '21': 'Оператор відхилив повідомлення',
  '27': 'Абонент недоступний',
  '28': 'Невідомий абонент',
  '38': 'Мережа недоступна',
  '41': 'Тимчасовий збій',
  '42': 'Перевантаження мережі',
  '208': 'Пам’ять SIM для SMS переповнена',
  '310': 'SIM не вставлено',
  '311': 'Потрібен PIN SIM',
  '313': 'Збій SIM',
  '322': 'Пам’ять переповнена',
  '330': 'Невідома адреса SMSC',
  '331': 'Немає мережі',
  '332': 'Тайм-аут мережі',
};

function cmsErrorText(code: string): string {
  return CMS_ERRORS[code] ?? `Помилка GSM, код CMS ${code}`;
}
