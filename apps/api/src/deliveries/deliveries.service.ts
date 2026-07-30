import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaClient, Prisma, DeliveryStatus } from '@umg/database';
import { AuditService } from '../common/audit.service';
import { QueueService } from '../queue/queue.service';

const SENSITIVE_HEADER = /secret|token|authorization/i;

const REPLAYABLE: DeliveryStatus[] = ['dlq', 'failed', 'delivered'];

export interface DeliveryListFilters {
  status?: DeliveryStatus;
  destinationId?: string;
  eventId?: string;
  take: number;
  skip: number;
}

@Injectable()
export class DeliveriesService {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async list(filters: DeliveryListFilters) {
    const where: Prisma.WebhookDeliveryWhereInput = {
      status: filters.status,
      destinationId: filters.destinationId,
      eventId: filters.eventId,
    };
    const [items, count] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        take: filters.take,
        skip: filters.skip,
        orderBy: { createdAt: 'desc' },
        include: {
          destination: { select: { id: true, name: true, type: true } },
          event: { select: { id: true, eventType: true, createdAt: true } },
        },
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return { items, count };
  }

  async get(id: string) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      include: {
        destination: { select: { id: true, name: true, type: true } },
        event: { select: { id: true, eventType: true, createdAt: true, payload: true } },
      },
    });
    if (!delivery) throw new NotFoundException('Доставку не знайдено.');
    return {
      ...delivery,
      requestJson: this.maskRequest(delivery.requestJson),
    };
  }

  async replay(id: string, actorId: string | null) {
    const original = await this.prisma.webhookDelivery.findUnique({ where: { id } });
    if (!original) throw new NotFoundException('Доставку не знайдено.');
    if (!REPLAYABLE.includes(original.status)) {
      throw new ConflictException(
        'Повторна відправка можлива лише для доставок у статусі dlq, failed або delivered.',
      );
    }

    // Spec §15.5: replay creates a NEW delivery with the same event ID and a new delivery ID.
    const fresh = await this.prisma.webhookDelivery.create({
      data: {
        eventId: original.eventId,
        destinationId: original.destinationId,
        status: 'pending',
        attemptCount: 0,
        requestJson: original.requestJson === null ? undefined : (original.requestJson as never),
      },
      include: {
        destination: { select: { id: true, name: true, type: true } },
        event: { select: { id: true, eventType: true, createdAt: true } },
      },
    });

    await this.queue.enqueueWebhookDelivery(fresh.id);
    await this.audit.log(actorId, 'delivery.replayed', 'delivery', fresh.id, { replayedFrom: id }, {
      eventId: fresh.eventId,
      destinationId: fresh.destinationId,
    });
    return fresh;
  }

  /** Mask any header containing 'secret'/'token'/'authorization' before returning. */
  private maskRequest(request: unknown): unknown {
    if (!request || typeof request !== 'object') return request;
    const clone = structuredClone(request) as { headers?: Record<string, unknown> };
    if (clone.headers && typeof clone.headers === 'object') {
      for (const key of Object.keys(clone.headers)) {
        if (SENSITIVE_HEADER.test(key)) clone.headers[key] = '********';
      }
    }
    return clone;
  }
}
