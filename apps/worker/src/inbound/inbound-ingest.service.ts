import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PrismaClient,
  MessageDirection,
  MessageStatus,
  MessageType,
  Prisma,
} from '@umg/database';
import type { AccountConfig, CanonicalInbound, EndpointConfig } from '@umg/channel-sdk';
import { AdaptersRegistry } from '../adapters/adapters.registry';
import { EventsService } from '../events/events.service';

/**
 * Turns a raw vendor payload into persisted inbound messages (TZ §15.1).
 *
 * This is the counterpart to MessageSendProcessor: every channel that can
 * receive funnels through here, so conversation threading, event emission and
 * de-duplication are defined once. Routing to destinations happens downstream
 * — `message.received` lands in the outbox and OutboxDispatcherScheduler hands
 * it to RoutingService.
 *
 * Two callers:
 *   - InboundIngestProcessor  — webhook payloads relayed by the API (gwmd)
 *   - SignalReceiveBridge     — envelopes read off signal-cli's websocket
 */
@Injectable()
export class InboundIngestService {
  private readonly logger = new Logger(InboundIngestService.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly adapters: AdaptersRegistry,
    private readonly events: EventsService,
  ) {}

  /**
   * @param adapterName vendor adapter the payload came from
   * @param raw         untouched vendor payload
   * @param endpointId  when the caller already knows the endpoint (Signal's
   *                    bridge subscribes per number); omitted for webhooks,
   *                    which carry their own routing hints
   */
  async ingest(adapterName: string, raw: unknown, endpointId?: string): Promise<number> {
    const endpoint = endpointId
      ? await this.prisma.endpoint.findUnique({ where: { id: endpointId } })
      : await this.resolveEndpoint(adapterName, raw);
    if (!endpoint) {
      this.logger.warn(
        `Dropping ${adapterName} inbound payload: no endpoint matched. ` +
          'The number is probably not linked in UMG.',
      );
      return 0;
    }

    const account = await this.prisma.transportAccount.findUnique({
      where: { id: endpoint.accountId },
    });
    if (!account) {
      this.logger.error(`Endpoint ${endpoint.id} references missing account`);
      return 0;
    }

    const adapter = this.adapters.get(account.adapter);
    if (!adapter?.normalizeInbound) {
      this.logger.error(`Adapter ${account.adapter} cannot normalise inbound payloads`);
      return 0;
    }

    const accountConfig: AccountConfig = {
      id: account.id,
      adapter: account.adapter,
      configJson: (account.encryptedConfig as Record<string, unknown>) ?? {},
    };
    const endpointConfig: EndpointConfig = {
      id: endpoint.id,
      externalId: endpoint.externalId ?? '',
      phoneE164: endpoint.phoneE164,
      label: endpoint.label ?? '',
      configJson: (endpoint.configJson as Record<string, unknown>) ?? {},
    };

    const canonical = adapter.normalizeInbound(accountConfig, endpointConfig, raw);
    if (canonical.length === 0) return 0;

    let stored = 0;
    for (const inbound of canonical) {
      if (await this.persist(inbound, endpoint, account)) stored++;
    }
    return stored;
  }

  /**
   * Webhook payloads have to say which endpoint they belong to. gwmd stamps
   * `session_id` with the device id we registered (which we store as
   * `Endpoint.externalId`) and `device_id` with the WhatsApp JID.
   */
  private async resolveEndpoint(adapterName: string, raw: unknown) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const accounts = await this.prisma.transportAccount.findMany({
      where: { adapter: adapterName },
      select: { id: true },
    });
    if (accounts.length === 0) return null;
    const accountIds = accounts.map((a) => a.id);

    const sessionId = typeof r['session_id'] === 'string' ? r['session_id'] : null;
    if (sessionId) {
      const bySession = await this.prisma.endpoint.findFirst({
        where: { accountId: { in: accountIds }, externalId: sessionId },
      });
      if (bySession) return bySession;
    }

    // Fall back to the JID's phone number. gwmd's `device_id` is the JID of
    // the paired account, e.g. "380671112233:3@s.whatsapp.net".
    const deviceJid = typeof r['device_id'] === 'string' ? r['device_id'] : null;
    const phone = deviceJid ? jidToPhone(deviceJid) : null;
    if (phone) {
      return this.prisma.endpoint.findFirst({
        where: { accountId: { in: accountIds }, phoneE164: phone },
      });
    }
    return null;
  }

  private async persist(
    inbound: CanonicalInbound,
    endpoint: { id: string; accountId: string },
    account: { id: string; type: string },
  ): Promise<boolean> {
    const externalId = inbound.externalId || null;

    // The same message can arrive twice: vendors retry webhooks, and the
    // Signal bridge replays its queue after a reconnect.
    if (externalId) {
      const existing = await this.prisma.message.findFirst({
        where: { endpointId: endpoint.id, externalId, direction: MessageDirection.inbound },
        select: { id: true },
      });
      if (existing) {
        this.logger.debug(`Inbound ${externalId} already stored as ${existing.id}`);
        return false;
      }
    }

    const channelType = account.type as never;
    const peerPhone = inbound.from.e164 ?? null;
    const peerRaw = inbound.from.raw ?? null;

    const conversation = await this.findOrCreateConversation(
      endpoint.id,
      channelType,
      peerPhone,
      peerRaw,
    );

    const message = await this.prisma.message.create({
      data: {
        direction: MessageDirection.inbound,
        channelType,
        accountId: endpoint.accountId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        externalId,
        messageType: toMessageType(inbound.type),
        // Inbound messages have no delivery lifecycle of their own; they are
        // terminal on arrival.
        status: MessageStatus.delivered,
        fromJson: inbound.from as unknown as Prisma.InputJsonValue,
        toJson: inbound.to as unknown as Prisma.InputJsonValue,
        contentJson: (inbound.content ?? {}) as unknown as Prisma.InputJsonValue,
        metadataJson: {} as Prisma.InputJsonValue,
        rawPayload: (inbound.rawPayload ?? {}) as Prisma.InputJsonValue,
        createdAt: inbound.receivedAt ?? new Date(),
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: inbound.receivedAt ?? new Date() },
    });

    await this.events.emit({
      type: 'message.received',
      aggregateId: message.id,
      channel: channelType,
      accountId: endpoint.accountId,
      endpointId: endpoint.id,
      // Dedup on the vendor id so a retried webhook cannot fan out twice.
      dedupKey: externalId ? `message.received:${endpoint.id}:${externalId}` : undefined,
      data: {
        message: {
          id: message.id,
          direction: 'inbound',
          channel_type: channelType,
          external_id: externalId,
          message_type: message.messageType,
          from: inbound.from,
          to: inbound.to,
          content: inbound.content,
          conversation_id: conversation.id,
          received_at: (inbound.receivedAt ?? new Date()).toISOString(),
        },
      },
    });

    this.logger.log(
      `Stored inbound ${message.messageType} ${message.id} from ${peerPhone ?? peerRaw ?? 'unknown'}`,
    );
    return true;
  }

  private async findOrCreateConversation(
    endpointId: string,
    channelType: never,
    peerPhone: string | null,
    peerRaw: string | null,
  ) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        endpointId,
        ...(peerPhone ? { peerPhoneE164: peerPhone } : { peerId: peerRaw }),
      },
    });
    if (existing) return existing;
    return this.prisma.conversation.create({
      data: {
        channelType,
        endpointId,
        peerId: peerRaw,
        peerPhoneE164: peerPhone,
        lastMessageAt: new Date(),
      },
    });
  }
}

/** Canonical inbound types map 1:1 onto the DB enum bar the unknown fallback. */
function toMessageType(type: string): MessageType {
  return (Object.values(MessageType) as string[]).includes(type)
    ? (type as MessageType)
    : MessageType.unknown;
}

/** "380671112233:3@s.whatsapp.net" → "+380671112233". */
function jidToPhone(jid: string): string | null {
  const m = /^(\d+)(?::\d+)?@/.exec(jid);
  return m ? `+${m[1]}` : null;
}
