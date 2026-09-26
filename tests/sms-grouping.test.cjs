const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { GoipVendorAdapter } = require('../packages/adapters/dist/goip-vendor/index.js');
const { smsGroupingSettings, smsGroupDeadline } = require('../packages/channel-sdk/dist/index.js');

const adapter = new GoipVendorAdapter();
const accountConfig = { id: 'test', adapter: 'goip-vendor', configJson: {} };
const endpointConfig = { id: 'test', externalId: 'line1', phoneE164: '+380501111111', label: 'test', configJson: {} };
const raw = (text, from = 'Sender', time = '2026-09-26 10:00:00') =>
  ({ goip_line: 'line1', from_number: from, content: text, recv_time: time });
const inbound = (text, from, time) => adapter.normalizeInbound(accountConfig, endpointConfig, raw(text, from, time))[0];

describe('GoIP identity and grouping policy', () => {
  it('retains different text in the same second and recognizes exact retries', () => {
    assert.notEqual(inbound('first').externalId, inbound('second').externalId);
    assert.equal(inbound('first').externalId, inbound('first').externalId);
    assert.notEqual(inbound('first', 'Other').externalId, inbound('first').externalId);
  });
  it('does not permanently suppress repeated text with missing/invalid timestamps', () => {
    assert.notEqual(inbound('test', 'Sender', '').externalId, inbound('test', 'Sender', '').externalId);
    assert.notEqual(inbound('test', 'Sender', 'invalid').externalId, inbound('test', 'Sender', 'invalid').externalId);
  });
  it('is opt-in and validates bounds', () => {
    assert.deepEqual(smsGroupingSettings(), { enabled: false, idleSeconds: 25, maxSeconds: 90 });
    for (const value of [null, [], true, { enabled: 'yes' }, { idleSeconds: 0 },
      { idleSeconds: 26, maxSeconds: 25 }, { maxSeconds: 301 }, { idleSeconds: 5.1 }]) {
      assert.throws(() => smsGroupingSettings(value));
    }
    assert.equal(smsGroupDeadline(new Date(80000), new Date(90000), 25).getTime(), 90000);
  });
});

const url = process.env.SMS_TEST_DATABASE_URL;
describe('SMS grouping with PostgreSQL', { skip: !url }, () => {
  const { PrismaClient, mergeEndpointConfig } = require('@umg/database');
  const { SmsGroupingService } = require('../apps/worker/dist/inbound/sms-grouping.service.js');
  const { EventsService } = require('../apps/worker/dist/events/events.service.js');
  const { SmsCorrectionsService } = require('../apps/api/dist/messages/sms-corrections.service.js');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const events = new EventsService(prisma);
  const outboxFailure = {
    emitInTransaction: (tx, params) => events.emitInTransaction(new Proxy(tx, {
      get(target, property) {
        if (property === 'eventOutbox') return {
          create: async () => { throw new Error('simulated outbox failure'); },
        };
        return target[property];
      },
    }), params),
  };
  const worker = () => new SmsGroupingService(prisma, events);
  let account;
  let endpoint;
  let service;
  const enabled = { smsGrouping: { enabled: true, idleSeconds: 25, maxSeconds: 90 } };
  const messages = () => prisma.message.findMany({
    where: { endpointId: endpoint.id }, include: { smsParts: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  const eventCount = () => prisma.messageEvent.count({ where: { endpointId: endpoint.id } });
  const expire = async (id) => prisma.message.update({ where: { id }, data: {
    smsGroupDueAt: new Date(0),
  } });

  before(async () => {
    if (!new URL(url).pathname.endsWith('/umg_sms_test')) {
      throw new Error('Use an isolated database named umg_sms_test.');
    }
    account = await prisma.transportAccount.create({ data: {
      name: 'SMS integration ' + randomUUID(), type: 'sms', adapter: 'goip-vendor', encryptedConfig: {},
    } });
  });
  beforeEach(async () => {
    endpoint = await prisma.endpoint.create({ data: {
      accountId: account.id, label: 'test', externalId: randomUUID(), configJson: enabled,
    } });
    service = worker();
  });
  after(async () => {
    if (account) {
      const ids = (await prisma.message.findMany({ where: { accountId: account.id }, select: { id: true } })).map((m) => m.id);
      await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
      await prisma.eventOutbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.messageEvent.deleteMany({ where: { accountId: account.id } });
      await prisma.messageStatusHistory.deleteMany({ where: { messageId: { in: ids } } });
      await prisma.message.deleteMany({ where: { accountId: account.id } });
      await prisma.conversation.deleteMany({ where: { endpoint: { accountId: account.id } } });
      await prisma.endpoint.deleteMany({ where: { accountId: account.id } });
      await prisma.transportAccount.delete({ where: { id: account.id } });
    }
    await prisma.$disconnect();
  });

  it('stores four Cyrillic parts, delays forwarding, resumes after restart, and emits once', async () => {
    const parts = ['Початок '.repeat(8), 'Середина '.repeat(7), 'Продовження ', 'Кінець'];
    for (const part of parts) assert.equal(await service.ingest(inbound(part), endpoint), true);
    let [m] = await messages();
    assert.equal(m.status, 'assembling');
    assert.equal(m.contentJson.text, parts.join(''));
    assert.equal(m.smsParts.length, 4);
    assert.equal(m.metadataJson.smsGrouping.approximate, true);
    assert.equal(await eventCount(), 0);
    assert.equal(await service.ingest(inbound(parts[1]), endpoint), false);
    await expire(m.id);
    await Promise.all([worker().finalizeDue(), worker().finalizeDue()]);
    [m] = await messages();
    assert.equal(m.status, 'delivered');
    assert.equal(m.smsGroupKey, null);
    assert.equal(await eventCount(), 1);
    const event = await prisma.messageEvent.findFirst({ where: { endpointId: endpoint.id } });
    assert.equal(event.payload.data.message.content.text, parts.join(''));
    assert.equal(await prisma.eventOutbox.count({ where: { aggregateId: m.id } }), 1);
    assert.equal(await service.ingest(inbound(parts[0]), endpoint), false);
    assert.equal(await eventCount(), 1);
  });

  it('serializes simultaneous parts and duplicate callbacks across workers', async () => {
    const results = await Promise.all([
      worker().ingest(inbound('a'), endpoint), worker().ingest(inbound('b'), endpoint),
      worker().ingest(inbound('a'), endpoint), worker().ingest(inbound('c'), endpoint),
    ]);
    assert.equal(results.filter(Boolean).length, 3);
    const rows = await messages();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].smsParts.map((p) => p.text).sort(), ['a', 'b', 'c']);
    assert.equal(rows[0].contentJson.text, rows[0].smsParts.map((p) => p.text).join(''));
  });

  it('keeps SIMs and senders separate', async () => {
    const other = await prisma.endpoint.create({ data: { accountId: account.id, label: 'other', configJson: enabled } });
    await service.ingest(inbound('a'), endpoint);
    await service.ingest(inbound('b', 'Other'), endpoint);
    await service.ingest(inbound('a'), other);
    assert.equal((await messages()).length, 2);
    assert.equal(await prisma.message.count({ where: { endpointId: other.id } }), 1);
  });

  it('closes an expired group before adding a late part and never modifies its event', async () => {
    await service.ingest(inbound('a'), endpoint);
    const [first] = await messages();
    await expire(first.id);
    await service.ingest(inbound('b'), endpoint);
    assert.equal((await messages()).length, 2);
    assert.equal(await eventCount(), 1);
    const event = await prisma.messageEvent.findFirst({ where: { endpointId: endpoint.id } });
    assert.equal(event.payload.data.message.content.text, 'a');
  });

  it('respects the hard deadline while extending the idle deadline', async () => {
    await service.ingest(inbound('a'), endpoint);
    const [first] = await messages();
    const expires = new Date(Date.now() + 10000);
    await prisma.message.update({ where: { id: first.id }, data: { smsGroupExpiresAt: expires } });
    await service.ingest(inbound('b'), endpoint);
    const [updated] = await messages();
    assert.equal(updated.smsGroupDueAt.getTime(), expires.getTime());
  });

  it('delivers immediately by default and closes a pending group when disabled', async () => {
    await service.ingest(inbound('a'), endpoint);
    endpoint.configJson = {};
    await service.ingest(inbound('b'), endpoint);
    const rows = await messages();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((m) => m.status === 'delivered' && m.smsParts.length === 1));
    assert.equal(await eventCount(), 2);
  });

  it('rolls back finalization when event persistence fails and retries successfully', async () => {
    await service.ingest(inbound('a'), endpoint);
    const [m] = await messages();
    await expire(m.id);
    const broken = new SmsGroupingService(prisma, outboxFailure);
    await broken.finalizeDue();
    assert.equal((await messages())[0].status, 'assembling');
    assert.equal(await eventCount(), 0);
    await worker().finalizeDue();
    assert.equal((await messages())[0].status, 'delivered');
    assert.equal(await eventCount(), 1);
  });

  it('rolls back a new immediate SMS on event failure, allowing callback retry', async () => {
    endpoint.configJson = {};
    const broken = new SmsGroupingService(prisma, outboxFailure);
    await assert.rejects(broken.ingest(inbound('a'), endpoint));
    assert.equal((await messages()).length, 0);
    assert.equal(await service.ingest(inbound('a'), endpoint), true);
    assert.equal(await eventCount(), 1);
  });

  it('deduplicates exact legacy replays without dropping different same-second content', async () => {
    const data = inbound('legacy');
    await prisma.message.create({ data: {
      direction: 'inbound', channelType: 'sms', accountId: account.id, endpointId: endpoint.id,
      externalId: 'line1:Sender:' + data.receivedAt.getTime(), messageType: 'text',
      status: 'delivered', fromJson: data.from, toJson: data.to, contentJson: data.content, rawPayload: data.rawPayload,
    } });
    assert.equal(await service.ingest(data, endpoint), false);
    assert.equal(await service.ingest(inbound('different'), endpoint), true);
    assert.equal((await messages()).length, 2);
  });

  it('reorders and splits locally, preserves originals and keeps delivery snapshots unchanged', async () => {
    await service.ingest(inbound('a'), endpoint);
    await service.ingest(inbound('b'), endpoint);
    let [m] = await messages();
    const corrections = new SmsCorrectionsService(prisma);
    await assert.rejects(corrections.correct(m.id, null, null), /Дочекайтеся/);
    await expire(m.id); await service.finalizeDue();
    const ids = m.smsParts.map((p) => p.id).reverse();
    await assert.rejects(corrections.correct(m.id, [ids[0], ids[0]], null));
    await corrections.correct(m.id, ids, null);
    [m] = await messages();
    assert.equal(m.contentJson.text, 'ba');
    const event = await prisma.messageEvent.findFirst({ where: { endpointId: endpoint.id } });
    assert.equal(event.payload.data.message.content.text, 'ab');
    await corrections.correct(m.id, null, null);
    const rows = await messages();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.smsParts.length === 1 && row.smsParts[0].rawPayload.content === row.contentJson.text));
    assert.equal(await service.ingest(inbound('a'), endpoint), false);
    assert.equal(await service.ingest(inbound('b'), endpoint), false);
    assert.equal(await eventCount(), 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: m.id } }), 2);
    await assert.rejects(corrections.correct(m.id, ids, null));
  });

  it('preserves grouping settings during concurrent balance updates and rejects invalid API settings', async () => {
    const { TransportAccountsService } = require('../apps/api/dist/transport-accounts/transport-accounts.service.js');
    const settingsApi = new TransportAccountsService(prisma, { log: async () => {} });
    await assert.rejects(settingsApi.updateEndpoint(endpoint.id, {
      config: { smsGrouping: { enabled: true, idleSeconds: 0 } },
    }, null));
    await Promise.all([
      settingsApi.updateEndpoint(endpoint.id, { config: {
        smsGrouping: { enabled: true, idleSeconds: 15, maxSeconds: 60 },
      } }, null),
      mergeEndpointConfig(prisma, endpoint.id, { balance: 42, balanceCurrency: 'UAH' }),
    ]);
    const saved = await prisma.endpoint.findUnique({ where: { id: endpoint.id } });
    assert.equal(saved.configJson.balance, 42);
    assert.equal(saved.configJson.smsGrouping.idleSeconds, 15);
  });

  it('bounds a group to 100 parts even during continuous traffic', async () => {
    for (let n = 0; n < 101; n++) await service.ingest(inbound(String(n)), endpoint);
    const rows = await messages();
    assert.equal(rows.length, 2);
    const complete = rows.find((m) => m.status === 'delivered');
    assert.equal(complete.smsParts.length, 100);
    assert.equal(rows.find((m) => m.status === 'assembling').smsParts.length, 1);
    assert.equal(await eventCount(), 1);
  });
});
