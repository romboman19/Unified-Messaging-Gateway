import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient, MessageStatus, ChannelType } from '@umg/database';
import { SendMessageResponse } from '@umg/contracts';
import { Inject } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../common/audit.service';
import { SendMessageDto } from './send-message.dto';

@Injectable()
export class MessagesService {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {
    void this.ensureMockChannel();
  }

  async ensureMockChannel(): Promise<void> {
    const existing = await this.prisma.transportAccount.findFirst({
      where: { adapter: 'mock' },
      include: { endpoints: true },
    });
    if (existing) return;
    const account = await this.prisma.transportAccount.create({
      data: {
        type: ChannelType.mock,
        adapter: 'mock',
        name: 'Mock channel',
        status: 'active',
        encryptedConfig: {},
        endpoints: {
          create: {
            label: 'Mock endpoint',
            externalId: 'mock-1',
            enabled: true,
            configJson: {},
          },
        },
      },
      include: { endpoints: true },
    });
    await this.audit.log('system', 'transport_account.created', 'transport_account', account.id, {}, { id: account.id, name: account.name });
  }

  async send(dto: SendMessageDto, idempotencyKey?: string, requestId = 'unknown'): Promise<SendMessageResponse> {
    if (dto.channel === 'mock') {
      const account = await this.prisma.transportAccount.findFirst({
        where: { adapter: 'mock' },
        include: { endpoints: { where: { enabled: true } } },
      });
      if (!account || account.endpoints.length === 0) {
        throw new UnprocessableEntityException('Mock endpoint недоступний.');
      }
      dto.accountId = account.id;
      dto.endpointId = account.endpoints[0].id;
    }

    if (idempotencyKey) {
      const existing = await this.prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
      if (existing) {
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

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          direction: 'outbound',
          channelType: dto.channel,
          accountId: dto.accountId,
          endpointId: dto.endpointId,
          externalId: null,
          messageType: dto.type,
          status: dto.scheduledAt ? MessageStatus.scheduled : MessageStatus.queued,
          fromJson: { raw: '', e164: '', display: '' } as never,
          toJson: { raw: dto.to, e164: dto.to, display: dto.to } as never,
          contentJson: dto.content as never,
          metadataJson: (dto.metadata ?? {}) as never,
          rawPayload: dto as unknown as never,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        },
      });
      await tx.messageStatusHistory.create({
        data: { messageId: created.id, status: created.status, source: 'api', payload: { requestId } },
      });
      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            requestHash: this.hashRequest(dto),
            responseRef: created.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });
      }
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

  async list(opts: { take: number; skip: number }) {
    const [items, count] = await Promise.all([
      this.prisma.message.findMany({
        take: opts.take,
        skip: opts.skip,
        orderBy: { createdAt: 'desc' },
        include: { attempts: true, statusHistory: true },
      }),
      this.prisma.message.count(),
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

  private hashRequest(dto: SendMessageDto): string {
    return JSON.stringify({ ...dto, scheduledAt: dto.scheduledAt ?? null });
  }
}
