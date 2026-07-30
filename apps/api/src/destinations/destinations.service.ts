import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient, WebhookDestination } from '@umg/database';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import { QueueService } from '../queue/queue.service';
import { CreateDestinationDto, UpdateDestinationDto } from './destinations.dto';

const SENSITIVE_CONFIG_KEY = /token|secret|password|key/i;

@Injectable()
export class DestinationsService {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async list() {
    const rows = await this.prisma.webhookDestination.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((d) => this.serialize(d)), count: rows.length };
  }

  async get(id: string) {
    const row = await this.prisma.webhookDestination.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Призначення не знайдено.');
    return this.serialize(row);
  }

  async getRaw(id: string): Promise<WebhookDestination> {
    const row = await this.prisma.webhookDestination.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Призначення не знайдено.');
    return row;
  }

  async create(dto: CreateDestinationDto, actorId: string | null) {
    const created = await this.prisma.webhookDestination.create({
      data: {
        name: dto.name,
        type: dto.type,
        enabled: dto.enabled ?? true,
        url: dto.url ?? null,
        secretEnc: dto.secret ?? null,
        configJson: (dto.config ?? {}) as never,
        fieldSelector: (dto.fieldSelector ?? []) as never,
        templateJson: dto.template === undefined ? undefined : (dto.template as never),
        timeoutMs: dto.timeoutMs ?? 10000,
      },
    });
    await this.audit.log(actorId, 'destination.created', 'destination', created.id, {}, {
      id: created.id,
      name: created.name,
      type: created.type,
    });
    return this.serialize(created);
  }

  async update(id: string, dto: UpdateDestinationDto, actorId: string | null) {
    const before = await this.get(id);
    const updated = await this.prisma.webhookDestination.update({
      where: { id },
      data: {
        name: dto.name,
        type: dto.type,
        enabled: dto.enabled,
        url: dto.url === undefined ? undefined : dto.url,
        secretEnc: dto.secret === undefined ? undefined : dto.secret,
        configJson: dto.config === undefined ? undefined : (dto.config as never),
        fieldSelector: dto.fieldSelector === undefined ? undefined : (dto.fieldSelector as never),
        templateJson: dto.template === undefined ? undefined : (dto.template as never),
        timeoutMs: dto.timeoutMs,
      },
    });
    await this.audit.log(actorId, 'destination.updated', 'destination', id, before, {
      id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
    });
    return this.serialize(updated);
  }

  async delete(id: string, actorId: string | null) {
    const before = await this.get(id);
    await this.prisma.webhookDestination.delete({ where: { id } });
    await this.audit.log(actorId, 'destination.deleted', 'destination', id, before, {});
    return { ok: true };
  }

  /**
   * Test delivery (spec §15.3 envelope used as body). Creates a MessageEvent +
   * WebhookDelivery (pending) and enqueues 'webhook.deliver' for immediate delivery,
   * then polls the DB for a terminal status for up to ~5s.
   */
  async test(id: string, actorId: string | null) {
    const destination = await this.getRaw(id);

    const envelope = {
      specversion: '1.0',
      id: `evt_${randomUUID()}`,
      type: 'umg.test',
      source: 'umg://api/destinations/test',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      account_id: null,
      endpoint_id: null,
      event_version: '1.0',
      data: { message: 'Тестове повідомлення UMG' },
    };

    const event = await this.prisma.messageEvent.create({
      data: {
        eventType: 'umg.test',
        payload: envelope as never,
      },
    });

    const requestSnapshot = {
      url: destination.url ?? null,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-umg-event-id': envelope.id,
      },
      body: envelope,
    };

    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        eventId: event.id,
        destinationId: destination.id,
        status: 'pending',
        attemptCount: 0,
        requestJson: requestSnapshot as never,
      },
    });

    await this.queue.enqueueWebhookDelivery(delivery.id);
    await this.audit.log(actorId, 'destination.tested', 'destination', destination.id, {}, {
      deliveryId: delivery.id,
    });

    const deadline = Date.now() + 5000;
    let current = delivery;
    while (Date.now() < deadline) {
      await sleep(250);
      const fresh = await this.prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
      if (!fresh) break;
      current = fresh;
      if (fresh.status === 'delivered' || fresh.status === 'failed' || fresh.status === 'dlq') break;
    }

    return {
      deliveryId: current.id,
      status: current.status,
      responseCode: current.lastResponseCode ?? null,
      responseExcerpt: this.excerpt(current),
      durationMs: current.durationMs ?? null,
    };
  }

  private excerpt(delivery: { responseJson: unknown; lastError: string | null }): string | null {
    const response = delivery.responseJson as { bodyExcerpt?: string; body?: unknown } | null;
    const raw = response?.bodyExcerpt ?? response?.body ?? delivery.lastError ?? null;
    if (raw === null || raw === undefined) return null;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return text.slice(0, 500);
  }

  /**
   * Public shape: never exposes secretEnc; sensitive config keys are masked.
   */
  serialize(d: WebhookDestination) {
    const { secretEnc, configJson, ...rest } = d;
    void secretEnc;
    return {
      ...rest,
      hasSecret: Boolean(d.secretEnc),
      configJson: this.maskConfig(configJson),
    };
  }

  private maskConfig(config: unknown): Record<string, unknown> {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      if (SENSITIVE_CONFIG_KEY.test(key) && typeof value === 'string' && value.length > 0) {
        result[key] = '********';
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
