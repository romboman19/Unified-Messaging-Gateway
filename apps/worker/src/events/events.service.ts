import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient, Prisma, ChannelType, MessageEvent } from '@umg/database';
import { randomUUID } from 'crypto';

export interface EmitEventParams {
  type: string;
  aggregateId?: string;
  channel?: ChannelType;
  accountId?: string;
  endpointId?: string;
  data: unknown;
  dedupKey?: string;
}

export interface CloudEventEnvelope {
  specversion: '1.0';
  id: string;
  type: string;
  source: string;
  subject?: string;
  time: string;
  datacontenttype: 'application/json';
  channel?: string;
  account_id?: string;
  endpoint_id?: string;
  event_version: '1.0';
  data: unknown;
}

export interface EmitEventResult {
  event: MessageEvent;
  created: boolean;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  /**
   * Persists a canonical CloudEvents envelope into message_events and registers
   * an event_outbox row for asynchronous fan-out. Both writes happen in one
   * transaction. When dedupKey is provided, the operation is idempotent:
   * a repeated key is skipped without creating a duplicate outbox record.
   */
  async emit(params: EmitEventParams): Promise<EmitEventResult> {
    const envelope = this.buildEnvelope(params);
    try {
      const event = await this.prisma.$transaction(async (tx) => {
        const created = await tx.messageEvent.create({
          data: {
            dedupKey: params.dedupKey ?? null,
            eventType: params.type,
            aggregateId: params.aggregateId ?? null,
            channelType: params.channel ?? null,
            accountId: params.accountId ?? null,
            endpointId: params.endpointId ?? null,
            payload: envelope as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.eventOutbox.create({
          data: {
            eventType: params.type,
            aggregateId: params.aggregateId ?? created.id,
            payload: { messageEventId: created.id },
          },
        });
        return created;
      });
      this.logger.debug(`Event ${params.type} persisted as ${event.id}`);
      return { event, created: true };
    } catch (err) {
      if (params.dedupKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.messageEvent.findUnique({
          where: { dedupKey: params.dedupKey },
        });
        if (existing) {
          this.logger.debug(`Event ${params.type} deduplicated by key ${params.dedupKey}`);
          return { event: existing, created: false };
        }
      }
      throw err;
    }
  }

  private buildEnvelope(params: EmitEventParams): CloudEventEnvelope {
    const sourceParts: string[] = [];
    if (params.channel) sourceParts.push(`channel/${params.channel}`);
    if (params.accountId) sourceParts.push(`account/${params.accountId}`);
    if (params.endpointId) sourceParts.push(`endpoint/${params.endpointId}`);
    const source = sourceParts.length > 0 ? `umg://${sourceParts.join('/')}` : 'umg://system';

    const envelope: CloudEventEnvelope = {
      specversion: '1.0',
      id: `evt_${randomUUID()}`,
      type: params.type,
      source,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      event_version: '1.0',
      data: params.data,
    };
    if (params.aggregateId && params.type.startsWith('message.')) {
      envelope.subject = `message/${params.aggregateId}`;
    }
    if (params.channel) envelope.channel = params.channel;
    if (params.accountId) envelope.account_id = params.accountId;
    if (params.endpointId) envelope.endpoint_id = params.endpointId;
    return envelope;
  }
}
