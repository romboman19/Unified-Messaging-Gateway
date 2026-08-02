import { Injectable, NotFoundException, UnprocessableEntityException, ConflictException } from '@nestjs/common';
import { PrismaClient, Prisma, MessageStatus, ChannelType, MessageDirection } from '@umg/database';
import { SendMessageResponse } from '@umg/contracts';
import { Inject } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../common/audit.service';
import { EventEmitterService } from '../common/event-emitter.service';
import { SendMessageDto } from './send-message.dto';

export interface MessageListFilters {
  status?: MessageStatus;
  channel?: ChannelType;
  direction?: MessageDirection;
  q?: string;
  take: number;
  skip: number;
}

@Injectable()
export class MessagesService {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly events: EventEmitterService,
  ) {}

  async send(dto: SendMessageDto, idempotencyKey?: string, requestId = 'unknown'): Promise<SendMessageResponse> {
    // Real transports (sms/whatsapp/signal) are now wired in via
    // `apps/worker` + `packages/adapters`. The hard "mock-only" guard
    // introduced in commit `fb6d179` is removed: any channel/endpoint
    // with an enabled account is acceptable.
    let accountId = dto.accountId;
    let endpointId = dto.endpointId;
    if (!accountId || !endpointId) {
      // Pick by channel type, never by a hardcoded adapter list: that list
      // silently omitted `gwmd` and, worse, matched accounts of any channel —
      // choosing "signal" in the UI could dispatch through the SMS account.
      const account = await this.prisma.transportAccount.findFirst({
        where: {
          type: dto.channel,
          status: 'active',
          endpoints: { some: { enabled: true } },
        },
        include: { endpoints: { where: { enabled: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      if (!account || account.endpoints.length === 0) {
        throw new UnprocessableEntityException(
          `Немає активного привʼязаного номера для каналу ${dto.channel}. ` +
            'Привʼяжіть номер на сторінці «Канали».',
        );
      }
      accountId = account.id;
      endpointId = account.endpoints[0].id;
    } else {
      const endpoint = await this.prisma.endpoint.findFirst({
        where: { id: endpointId, accountId, enabled: true },
      });
      if (!endpoint) {
        throw new UnprocessableEntityException('Endpoint недоступний або вимкнений.');
      }
    }
    dto.accountId = accountId;
    dto.endpointId = endpointId;

    const requestHash = this.hashRequest(dto);
    if (idempotencyKey) {
      const existing = await this.prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
      if (existing) {
        // Spec §14.4: same key with a DIFFERENT request payload is a conflict.
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Ключ ідемпотентності вже використано з іншим запитом (IDEMPOTENCY_CONFLICT).',
          );
        }
        const message = await this.prisma.message.findUnique({ where: { id: existing.responseRef } });
        if (message) {
          return {
            id: message.id,
            status: message.status,
            scheduledAt: message.scheduledAt?.toISOString() ?? null,
            createdAt: message.createdAt.toISOString(),
          };
        }
      }
    }

    const attachmentIds = [...new Set(dto.attachments ?? [])];
    if (attachmentIds.length > 0) {
      const attachments = await this.prisma.attachment.findMany({
        where: { id: { in: attachmentIds } },
        select: { id: true, deletedAt: true },
      });
      if (attachments.length !== attachmentIds.length) {
        throw new UnprocessableEntityException('Один або кілька вкладень не існують.');
      }
      if (attachments.some((a) => a.deletedAt)) {
        throw new UnprocessableEntityException('Одне з вкладень було видалено.');
      }
    }

    const contentWithAttachments = { ...dto.content, attachments: attachmentIds };

    // Thread the outbound message onto a conversation with the recipient, the
    // same way inbound ingestion does. Without this every sent message has a
    // null conversationId, so the Test-chat conversation list stays empty and
    // the admin never sees the message or its delivery status.
    const conversation = await this.findOrCreateConversation(
      dto.endpointId!,
      dto.channel,
      dto.to,
    );

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          direction: 'outbound',
          channelType: dto.channel,
          accountId: dto.accountId,
          endpointId: dto.endpointId,
          conversationId: conversation.id,
          externalId: null,
          messageType: dto.type,
          status: dto.scheduledAt ? MessageStatus.scheduled : MessageStatus.queued,
          fromJson: { raw: '', e164: '', display: '' } as never,
          toJson: { raw: dto.to, e164: dto.to, display: dto.to } as never,
          contentJson: contentWithAttachments as never,
          metadataJson: ({ ...(dto.metadata ?? {}), replyToMessageId: dto.replyToMessageId ?? null }) as never,
          rawPayload: dto as unknown as never,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        },
      });
      await tx.messageStatusHistory.create({
        data: { messageId: created.id, status: created.status, source: 'api', payload: { requestId } },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      if (attachmentIds.length > 0) {
        await tx.attachment.updateMany({
          where: { id: { in: attachmentIds } },
          data: { messageId: created.id },
        });
      }
      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            requestHash,
            responseRef: created.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });
      }
      // Canonical event (spec §15.3); worker performs the actual routing.
      await this.events.emit(tx, {
        type: 'message.queued',
        aggregateId: created.id,
        channel: created.channelType,
        accountId: created.accountId,
        endpointId: created.endpointId,
        dedupKey: `msg-${created.id}-message.queued`,
        data: {
          message: {
            id: created.id,
            direction: created.direction,
            channelType: created.channelType,
            messageType: created.messageType,
            status: created.status,
            to: dto.to,
            scheduledAt: created.scheduledAt?.toISOString() ?? null,
          },
        },
      });
      return created;
    });

    if (!dto.scheduledAt) {
      await this.queue.enqueueSend(message.id);
    }

    return {
      id: message.id,
      status: message.status,
      scheduledAt: message.scheduledAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
    };
  }

  async list(filters: MessageListFilters) {
    const where: Prisma.MessageWhereInput = {
      status: filters.status,
      channelType: filters.channel,
      direction: filters.direction,
    };
    if (filters.q) {
      where.OR = [
        { id: { contains: filters.q } },
        { externalId: { contains: filters.q } },
        { toJson: { path: ['e164'], string_contains: filters.q } },
        { toJson: { path: ['raw'], string_contains: filters.q } },
      ];
    }
    const [items, count] = await Promise.all([
      this.prisma.message.findMany({
        where,
        take: filters.take,
        skip: filters.skip,
        orderBy: { createdAt: 'desc' },
        include: { attempts: true, statusHistory: true },
      }),
      this.prisma.message.count({ where }),
    ]);
    return { items, count };
  }

  async get(id: string) {
    const message = await this.prisma.message.findUnique({
      where: { id },
      include: { attempts: true, statusHistory: true },
    });
    if (!message) throw new NotFoundException('Повідомлення не знайдено.');
    return message;
  }

  async retry(id: string, actorId: string | null) {
    const message = await this.prisma.message.findUnique({ where: { id } });
    if (!message) throw new NotFoundException('Повідомлення не знайдено.');
    if (message.status !== 'failed' && message.status !== 'cancelled') {
      throw new ConflictException(
        'Повторна відправка можлива лише для повідомлень у статусі failed або cancelled.',
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const m = await tx.message.update({
        where: { id },
        data: { status: MessageStatus.queued },
      });
      await tx.messageStatusHistory.create({
        data: { messageId: id, status: MessageStatus.queued, source: 'api', payload: { action: 'retry', actorId } },
      });
      return m;
    });
    // Unique jobId: BullMQ dedupes by jobId, so retries need a fresh suffix.
    await this.queue.enqueueSend(id, `retry-${Date.now()}`);
    await this.audit.log(actorId, 'message.retried', 'message', id, { status: message.status }, { status: updated.status });
    return updated;
  }

  async cancel(id: string, actorId: string | null) {
    const message = await this.prisma.message.findUnique({ where: { id } });
    if (!message) throw new NotFoundException('Повідомлення не знайдено.');
    if (message.status !== 'scheduled' && message.status !== 'queued') {
      throw new ConflictException(
        'Скасування можливе лише для повідомлень у статусі scheduled або queued.',
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const m = await tx.message.update({
        where: { id },
        data: { status: MessageStatus.cancelled },
      });
      await tx.messageStatusHistory.create({
        data: { messageId: id, status: MessageStatus.cancelled, source: 'api', payload: { action: 'cancel', actorId } },
      });
      return m;
    });
    try {
      await this.queue.removeSend(id);
    } catch {
      // Job may already be processing or gone — cancellation in DB still stands.
    }
    await this.audit.log(actorId, 'message.cancelled', 'message', id, { status: message.status }, { status: updated.status });
    return updated;
  }

  /**
   * Conversations are keyed by (endpoint, peer). The peer for an outbound
   * message is the recipient; for inbound it is the sender — both sides land
   * on the same row so a reply continues the thread rather than starting a
   * new one.
   */
  private async findOrCreateConversation(endpointId: string, channel: ChannelType, to: string) {
    const peer = to.startsWith('+') ? to : `+${to.replace(/\D/g, '')}`;
    const existing = await this.prisma.conversation.findFirst({
      where: { endpointId, peerPhoneE164: peer },
    });
    if (existing) return existing;
    return this.prisma.conversation.create({
      data: {
        channelType: channel,
        endpointId,
        peerId: to,
        peerPhoneE164: peer,
        lastMessageAt: new Date(),
      },
    });
  }

  private hashRequest(dto: SendMessageDto): string {
    return JSON.stringify({ ...dto, scheduledAt: dto.scheduledAt ?? null });
  }
}
