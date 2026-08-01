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
if (!['dbsms', 'unoapi', 'signal'].includes(vendor)) {
  console.error(`STUB_VENDOR must be one of dbsms, unoapi, signal (got "${vendor}")`);
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

    app.get('/v1/health', (_req, res) => res.json({ ok: true }));

    // Provisioning — wizard entry point (mirrors real `GET /v1/qrcodelink`).
    app.get('/v1/qrcodelink', (req, res) => {
      const deviceName = String(req.query.device_name ?? '').trim();
      if (!deviceName) {
        return res.status(400).json({ error: 'device_name required' });
      }
      const uri = `signalcaptcha://signal.group/#device_name=${encodeURIComponent(
        deviceName,
      )}`;
      res.json({
        uri,
        device_name: deviceName,
        expires_in: 600,
      });
    });

    // Dev-only: simulate the admin scanning the QR on their phone.
    app.post('/v1/_stub/link', (req, res) => {
      const deviceName = String(req.body?.device_name ?? '').trim();
      if (!deviceName) {
        return res.status(400).json({ error: 'device_name required' });
      }
      const number = `+10000000000`;
      const uuid = `uuid-${deviceName}-${Math.random().toString(36).slice(2, 10)}`;
      accounts.set(deviceName, { number, device_name: deviceName, uuid });
      res.json({ ok: true, number, device_name: deviceName, uuid });
    });

    app.get('/v1/accounts', (_req, res) => {
      res.json(Array.from(accounts.values()));
    });

    app.delete('/v1/accounts/:number', (req, res) => {
      const target = req.params.number;
      for (const [key, acc] of accounts.entries()) {
        if (acc.number === target) {
          accounts.delete(key);
          return res.json({ ok: true });
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

  return app;
}

const app = buildApp();
app.listen(port, () => {
  console.log(`[stub:${vendor}] listening on :${port}`);
});
