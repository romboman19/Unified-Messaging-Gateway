/* eslint-disable */
// UMG transport sidecar stub — single image, vendor selected by STUB_VENDOR.
//
// Provides an honest in-memory implementation of the subsets our adapters
// need so dev/CI flows work end-to-end without vendor hardware. This is
// NOT a production target; production must swap to the real sidecars.
//
// Set STUB_VENDOR ∈ {dbsms, unoapi, signal} to pick which vendor the
// process impersonates. The container then listens on the canonical port
// for that vendor and exposes only that vendor's routes.

import express from 'express';

const vendor = (process.env.STUB_VENDOR ?? '').toLowerCase();
if (!['dbsms', 'unoapi', 'signal', 'gwmd'].includes(vendor)) {
  console.error(`STUB_VENDOR must be one of dbsms, unoapi, signal, gwmd (got "${vendor}")`);
  process.exit(2);
}

const port = Number(process.env.STUB_PORT ?? 8080);

const sharedSent = new Map(); // external id → { status }

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, vendor }));

  // ─────────────────── DBLtek GoIP SMS Server v1.30.1 (TZ §21) ────────
  if (vendor === 'dbsms') {
    app.get('/querylines.asp', (req, res) => {
      const { Username, Password } = req.query;
      if (!Username || !Password) return res.status(401).send('missing creds');
      res.set('content-type', 'text/plain');
      res.send(
        'Line,Status,GSM,SIM\n' +
          [1, 2, 3, 4].map((n) => `${n},Free,100,SIM${n}-U`).join('\n') +
          '\n',
      );
    });

    app.post('/goip_sendsms.asp', (req, res) => {
      const { Username, Password, Tel, Line, smskey, Message } = req.query;
      if (!Username || !Password) return res.status(401).send('missing creds');
      const externalId = String(smskey ?? `db-${Date.now()}`);
      sharedSent.set(externalId, { status: 'dispatched', Tel, Line, Message });
      // Auto-progress: dispatched → sent → delivered.
      setTimeout(() => sharedSent.set(externalId, { ...sharedSent.get(externalId), status: 'sent' }), 30);
      setTimeout(() => sharedSent.set(externalId, { ...sharedSent.get(externalId), status: 'delivered' }), 90);
      res.set('content-type', 'text/plain');
      res.send('ok');
    });

    app.get('/goip_get_sms_status.asp', (req, res) => {
      const { smskey } = req.query;
      const entry = sharedSent.get(String(smskey ?? ''));
      res.set('content-type', 'text/plain');
      res.send(entry ? `${smskey},${entry.status}` : `${smskey},unknown`);
    });

    // Inbound callback. Stubs receive via POST.
    app.post('/inbound-stub', (req, res) => res.json({ ok: true }));
  }

  // ─────────────────── UnoAPI Cloud (WhatsApp) (TZ §23) ────────────────
  if (vendor === 'unoapi') {
    // in-memory session store: phone → { state, qrUri }
    const sessions = new Map();

    app.get('/ping', (_req, res) => res.json({ ok: true }));

    // Provisioning — wizard entry point (mirrors real UnoAPI `/session/:phone/qr`).
    app.get('/session/:phone/qr', (req, res) => {
      const phone = req.params.phone;
      if (!sessions.has(phone)) {
        sessions.set(phone, { state: 'qr_pending', qrUri: null });
      }
      const session = sessions.get(phone);
      session.qrUri =
        session.qrUri ??
        `waqr://session/${encodeURIComponent(phone)}?token=${Date.now().toString(36)}`;
      res.json({
        phone,
        qr: session.qrUri,
        state: session.state,
      });
    });

    // Dev-only: simulate user scanning the QR on their phone.
    app.post('/session/:phone/_stub/connect', (req, res) => {
      const phone = req.params.phone;
      if (!sessions.has(phone)) {
        return res.status(404).json({ error: 'session not found' });
      }
      sessions.get(phone).state = 'connected';
      res.json({ ok: true, phone, state: 'connected' });
    });

    app.get('/admin/sessions', (_req, res) => {
      const list = [];
      for (const [phone, s] of sessions.entries()) {
        if (s.state === 'connected') {
          list.push({ phone, state: s.state });
        }
      }
      res.json(list);
    });

    app.delete('/session/:phone', (req, res) => {
      sessions.delete(req.params.phone);
      res.json({ ok: true });
    });

    app.post('/v15.0/:phone/messages', (req, res) => {
      const externalId = `wa-msg-${Date.now()}`;
      sharedSent.set(externalId, { phone: req.params.phone, body: req.body, status: 'sent' });
      // Receipts: delivered after short delay.
      setTimeout(() => sharedSent.set(externalId, { ...sharedSent.get(externalId), status: 'delivered' }), 80);
      res.json({ messages: [{ id: externalId }] });
    });

    app.post('/inbound-stub', (req, res) => res.json({ ok: true, body: req.body }));
  }

  // ─────────────────── signal-cli-rest-api (TZ §24) ────────────────────
  if (vendor === 'signal') {
    // in-memory account store: deviceName → { number, deviceName, uuid }
    const accounts = new Map();
    // deviceName → last minted device link URI
    const linkUris = new Map();

    // The real endpoint answers 204 with no body.
    app.get('/v1/health', (_req, res) => res.status(204).end());

    // Provisioning — wizard entry point. The real sidecar splits this in two:
    //   GET /v1/qrcodelink      → image/png of the QR (NOT json)
    //   GET /v1/qrcodelink/raw  → { "device_link_uri": "sgnl://linkdevice?…" }
    // The adapter uses the raw variant; mirror both so a wrong call fails
    // here the same way it would in production.
    app.get('/v1/qrcodelink/raw', (req, res) => {
      const deviceName = String(req.query.device_name ?? '').trim();
      if (!deviceName) {
        return res.status(400).json({ error: 'Please provide a name for the device' });
      }
      const uri =
        `sgnl://linkdevice?uuid=stub-${encodeURIComponent(deviceName)}` +
        `&pub_key=stub${Date.now().toString(36)}`;
      linkUris.set(deviceName, uri);
      res.json({ device_link_uri: uri });
    });

    app.get('/v1/qrcodelink', (req, res) => {
      const deviceName = String(req.query.device_name ?? '').trim();
      if (!deviceName) {
        return res.status(400).json({ error: 'Please provide a name for the device' });
      }
      // A 1x1 PNG is enough: the point is the content type, so callers that
      // wrongly expect JSON here blow up in dev exactly as they would in prod.
      res.set('content-type', 'image/png');
      res.send(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
    });

    // Dev-only: simulate the admin scanning the QR on their phone. The
    // caller may pass an explicit `number`; otherwise we derive a distinct
    // one per device so the API's snapshot-diff matching is exercised for
    // real rather than always seeing the same phone.
    app.post('/v1/_stub/link', (req, res) => {
      const deviceName = String(req.body?.device_name ?? req.body?.deviceName ?? '').trim();
      if (!deviceName) {
        return res.status(400).json({ error: 'device_name required' });
      }
      const number = String(req.body?.number ?? `+1${String(1e9 + accounts.size + 1)}`);
      const uuid = `uuid-${deviceName}-${Math.random().toString(36).slice(2, 10)}`;
      accounts.set(deviceName, { number, device_name: deviceName, uuid });
      res.json({ ok: true, number, device_name: deviceName, uuid, link_uri: linkUris.get(deviceName) ?? null });
    });

    // The real endpoint returns a bare list of numbers — no uuid, no device
    // name. Anything that needs to identify *which* device was just linked
    // has to diff this list against a pre-link snapshot.
    app.get('/v1/accounts', (_req, res) => {
      res.json(Array.from(accounts.values()).map((a) => a.number));
    });

    // UMG is itself a linked device, so "unlink" drops our local keys. The
    // real API has no DELETE /v1/accounts/:number.
    app.delete('/v1/devices/:number/local-data', (req, res) => {
      const target = req.params.number;
      for (const [key, acc] of accounts.entries()) {
        if (acc.number === target) {
          accounts.delete(key);
          return res.status(204).end();
        }
      }
      res.status(404).json({ error: 'not found' });
    });

    app.post('/v2/send', (req, res) => {
      const externalId = `${Date.now()}`;
      sharedSent.set(externalId, { body: req.body, status: 'sent' });
      res.json({ results: { [req.body?.recipients?.[0] ?? 'unknown']: { timestamp: Date.now(), externalId } } });
    });

    app.post('/v1/register/:number', (_req, res) => res.json({ ok: true }));
    app.post('/v1/register/:number/verify/:code', (_req, res) => res.json({ ok: true }));
    app.post('/inbound-stub', (req, res) => res.json({ ok: true, body: req.body }));
  }

  // ─────────────── go-whatsapp-web-multidevice (TZ §1038) ─────────────
  // gwmd is the canonical WhatsApp sidecar in production; in dev we mock
  // its REST surface so the wizard flow can be exercised end-to-end without
  // pulling the real Go binary (which would need a real phone to pair).
  if (vendor === 'gwmd') {
    // in-memory device store: deviceId → { device_id, jid, is_logged_in }
    const devices = new Map();
    // in-memory session store: deviceId → { qrToken, expiresAt }
    const sessions = new Map();

    app.get('/health', (_req, res) => res.json({ ok: true, vendor }));

    // gwmd mounts REST under `/app`. We treat `/app` as an opaque prefix
    // for the adapter — so dev callers go to `/app/devices` etc.
    app.get('/app/devices', (_req, res) => {
      const list = [];
      for (const d of devices.values()) list.push(d);
      res.json({ status: 200, code: 'SUCCESS', results: list });
    });

    app.post('/app/devices', (req, res) => {
      const deviceId = String(req.body?.device_id ?? '').trim();
      if (!deviceId) return res.status(400).json({ error: 'device_id required' });
      // gwmd is idempotent on create. Field names mirror the real
      // `domains/device.Device` JSON: id, phone_number, display_name, state,
      // jid, created_at — a fresh device is `disconnected` with no JID until
      // someone scans the QR.
      const existing = devices.get(deviceId);
      if (existing) {
        return res.json({ status: 200, code: 'SUCCESS', message: 'Device added', results: existing });
      }
      const record = { id: deviceId, jid: '', state: 'disconnected', created_at: new Date().toISOString() };
      devices.set(deviceId, record);
      res.json({ status: 200, code: 'SUCCESS', message: 'Device added', results: record });
    });

    app.get('/app/devices/:device_id/login', (req, res) => {
      const deviceId = req.params.device_id;
      if (!devices.has(deviceId)) {
        return res.status(404).json({ status: 404, code: 'NOT_FOUND', message: 'device not found' });
      }
      const token = `gwmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessions.set(deviceId, { qrToken: token, expiresAt: Date.now() + 60_000 });
      // The real gwmd serves the QR as a PNG under its own /app/statics path
      // and builds an absolute URL from the request Host. Reproduce that
      // exactly — an absolute, sidecar-internal URL — so the API's image
      // proxy is exercised in dev instead of being bypassed by a data: URL.
      const qr_link = `${req.protocol}://${req.get('host')}/app/statics/qrcode/scan-qr-${encodeURIComponent(
        deviceId,
      )}.png`;
      res.json({
        status: 200,
        code: 'SUCCESS',
        message: 'Login success',
        results: {
          device_id: deviceId,
          qr_link,
          qr_duration: 60,
        },
      });
    });

    // Serves what `qr_link` points at. Real gwmd renders the pairing QR here.
    app.get('/app/statics/qrcode/:file', (_req, res) => {
      res.set('content-type', 'image/png');
      res.send(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
    });

    app.get('/app/devices/:device_id/status', (req, res) => {
      const deviceId = req.params.device_id;
      const d = devices.get(deviceId);
      if (!d) {
        return res.status(404).json({
          status: 404,
          code: 'NOT_FOUND',
          message: 'device not found',
          results: { device_id: deviceId, is_connected: false, is_logged_in: false },
        });
      }
      res.json({
        status: 200,
        code: 'SUCCESS',
        message: 'Device status',
        results: {
          device_id: deviceId,
          is_connected: true,
          is_logged_in: d.state === 'logged_in',
          jid: d.jid ?? '',
        },
      });
    });

    app.delete('/app/devices/:device_id', (req, res) => {
      const deviceId = req.params.device_id;
      devices.delete(deviceId);
      sessions.delete(deviceId);
      res.json({ status: 200, code: 'SUCCESS', message: 'Device deleted' });
    });

    // Dev-only: simulate the admin scanning the QR on their phone.
    app.post('/app/devices/:device_id/_stub/connect', (req, res) => {
      const deviceId = req.params.device_id;
      const d = devices.get(deviceId);
      if (!d) {
        return res.status(404).json({ status: 404, code: 'NOT_FOUND', message: 'device not found' });
      }
      d.jid = req.body?.jid ?? `${deviceId.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
      d.state = 'logged_in';
      d.phone_number = `+${d.jid.replace(/[^0-9]/g, '')}`;
      res.json({ status: 200, code: 'SUCCESS', message: 'paired', results: d });
    });

    // Send routes are device-agnostic; the device comes from X-Device-Id.
    app.post('/app/send/:kind', (req, res) => {
      const deviceId = req.get('x-device-id') ?? req.query.device_id ?? '';
      if (!deviceId) {
        return res.status(400).json({
          status: 400,
          code: 'DEVICE_ID_REQUIRED',
          message: 'device_id is required via X-Device-Id header or device_id query',
        });
      }
      const externalId = `gwmd-msg-${Date.now()}`;
      sharedSent.set(externalId, {
        device_id: deviceId,
        kind: req.params.kind,
        body: req.body,
        status: 'sent',
      });
      res.json({ status: 200, code: 'SUCCESS', results: { message_id: externalId } });
    });

    app.post('/inbound-stub', (req, res) => res.json({ ok: true, body: req.body }));
  }

  return app;
}

const app = buildApp();
app.listen(port, () => {
  console.log(`[stub:${vendor}] listening on :${port}`);
});
