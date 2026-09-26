import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaClient, Prisma, Endpoint, Message } from '@umg/database';
import { CanonicalInbound, smsGroupingSettings, smsGroupDeadline } from '@umg/channel-sdk';
import { createHash } from 'node:crypto';
import { EventsService } from '../events/events.service';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const object = (value: Prisma.JsonValue) => (value ?? {}) as Record<string, any>;

/** GoIP drops concatenation headers. This is explicitly approximate grouping. */
@Injectable()
export class SmsGroupingService {
  private readonly logger = new Logger(SmsGroupingService.name);
  private sweeping = false;

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly events: EventsService,
  ) {}

  async ingest(inbound: CanonicalInbound, endpoint: Endpoint): Promise<boolean> {
    const settings = smsGroupingSettings(object(endpoint.configJson).smsGrouping);
    const peer = inbound.from.e164 ?? inbound.from.raw;
    const key = createHash('sha256').update(JSON.stringify([endpoint.id, peer])).digest('hex');
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, key);
      if (await tx.smsPart.findUnique({
        where: { endpointId_sourceKey: { endpointId: endpoint.id, sourceKey: inbound.externalId } },
      })) return false;

      // Exact replays of pre-migration rows remain deduplicated. Different text
      // in the same second must survive, even if the old id matches.
      const raw = (inbound.rawPayload ?? {}) as Record<string, unknown>;
      const legacyId = `${raw.goip_line ?? 'line'}:${inbound.from.raw}:${inbound.receivedAt.getTime()}`;
      if (await tx.message.findFirst({ where: {
        endpointId: endpoint.id, direction: 'inbound', externalId: legacyId,
        contentJson: { path: ['text'], equals: inbound.content.text ?? '' },
      } })) return false;

      const now = await this.now(tx);
      let group = await tx.message.findUnique({ where: { smsGroupKey: key } });
      if (group && (!settings.enabled || group.smsGroupDueAt! <= now)) {
        await this.finalize(tx, group);
        group = null;
      }
      if (!group) {
        let conversation = await tx.conversation.findFirst({ where: {
          endpointId: endpoint.id,
          ...(inbound.from.e164 ? { peerPhoneE164: peer } : { peerId: peer }),
        } });
        conversation ??= await tx.conversation.create({ data: {
          channelType: 'sms', endpointId: endpoint.id, peerId: inbound.from.raw,
          peerPhoneE164: inbound.from.e164,
        } });
        const expires = new Date(now.getTime() + settings.maxSeconds * 1000);
        group = await tx.message.create({ data: {
          direction: 'inbound', channelType: 'sms', accountId: endpoint.accountId,
          endpointId: endpoint.id, conversationId: conversation.id,
          externalId: inbound.externalId, messageType: 'text', status: 'assembling',
          fromJson: json(inbound.from), toJson: json(inbound.to),
          contentJson: json(inbound.content), rawPayload: json(inbound.rawPayload ?? {}),
          metadataJson: { smsGrouping: { ...settings, approximate: false, partCount: 0 } },
          createdAt: inbound.receivedAt,
          smsGroupKey: settings.enabled ? key : null,
          smsGroupExpiresAt: settings.enabled ? expires : null,
          smsGroupDueAt: settings.enabled ? smsGroupDeadline(now, expires, settings.idleSeconds) : null,
        } });
      }
      const count = await tx.smsPart.count({ where: { messageId: group.id } });
      await tx.smsPart.create({ data: {
        messageId: group.id, endpointId: endpoint.id, sourceKey: inbound.externalId,
        text: inbound.content.text ?? '', rawPayload: json(inbound.rawPayload ?? {}),
        receivedAt: inbound.receivedAt, arrivedAt: now, position: count,
      } });
      const metadata = object(group.metadataJson);
      const policy = metadata.smsGrouping;
      group = await tx.message.update({ where: { id: group.id }, data: {
        contentJson: json({ ...object(group.contentJson),
          text: count === 0 ? inbound.content.text ?? '' :
            String(object(group.contentJson).text ?? '') + (inbound.content.text ?? '') }),
        metadataJson: json({ ...metadata, smsGrouping: {
          ...policy, partCount: count + 1, approximate: count > 0,
        } }),
        smsGroupDueAt: settings.enabled
          ? smsGroupDeadline(now, group.smsGroupExpiresAt!, policy.idleSeconds) : null,
      } });
      await tx.conversation.updateMany({
        where: { id: group.conversationId!, OR: [
          { lastMessageAt: null }, { lastMessageAt: { lt: inbound.receivedAt } },
        ] },
        data: { lastMessageAt: inbound.receivedAt },
      });
      // Bound memory/payload growth as well as time, even under continuous traffic.
      if (!settings.enabled || count + 1 >= 100) await this.finalize(tx, group);
      return true;
    }, { timeout: 15000 });
  }

  @Interval(1000)
  async finalizeDue(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const [{ now }] = await this.prisma.$queryRaw<Array<{ now: Date }>>
        `SELECT clock_timestamp() AS now`;
      const groups = await this.prisma.message.findMany({
        where: { smsGroupDueAt: { lte: now } }, orderBy: { smsGroupDueAt: 'asc' },
        take: 100, select: { id: true, smsGroupKey: true },
      });
      for (const candidate of groups) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await this.lock(tx, candidate.smsGroupKey!);
            const current = await tx.message.findUnique({ where: { id: candidate.id } });
            if (current?.smsGroupKey && current.smsGroupDueAt! <= await this.now(tx)) {
              await this.finalize(tx, current);
            }
          }, { timeout: 15000 });
        } catch (error) {
          this.logger.error(`SMS group ${candidate.id} will retry: ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.error(`SMS grouping sweep failed: ${String(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async lock(tx: Prisma.TransactionClient, key: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  private async now(tx: Prisma.TransactionClient): Promise<Date> {
    const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return row.now;
  }

  private async finalize(tx: Prisma.TransactionClient, message: Message) {
    await tx.message.update({ where: { id: message.id }, data: {
      status: 'delivered', smsGroupKey: null, smsGroupDueAt: null, smsGroupExpiresAt: null,
    } });
    await tx.messageStatusHistory.create({ data: {
      messageId: message.id, status: 'delivered', source: 'sms-grouping',
      payload: message.metadataJson as Prisma.InputJsonValue,
    } });
    await this.events.emitInTransaction(tx, {
      type: 'message.received', aggregateId: message.id, channel: 'sms',
      accountId: message.accountId, endpointId: message.endpointId,
      dedupKey: `message.received:sms:${message.id}`,
      data: { message: {
        id: message.id, direction: 'inbound', channel_type: 'sms',
        external_id: message.externalId, message_type: 'text',
        from: message.fromJson, to: message.toJson, content: message.contentJson,
        metadata: message.metadataJson, conversation_id: message.conversationId,
        received_at: message.createdAt.toISOString(),
      } },
    });
  }
}

