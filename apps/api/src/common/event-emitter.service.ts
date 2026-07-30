import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient, Prisma } from '@umg/database';
import { randomUUID } from 'node:crypto';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface EmitEventInput {
  type: string;
  aggregateId?: string | null;
  channel?: string | null;
  accountId?: string | null;
  endpointId?: string | null;
  data: Record<string, unknown>;
  dedupKey?: string;
}

/**
 * Lightweight canonical event emitter (spec §15.3).
 * Builds the CloudEvents-style envelope and persists a message_events row.
 * The worker consumes these rows and performs the actual routing/delivery.
 */
@Injectable()
export class EventEmitterService {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async emit(input: EmitEventInput): Promise<string>;
  async emit(client: DbClient, input: EmitEventInput): Promise<string>;
  async emit(clientOrInput: DbClient | EmitEventInput, maybeInput?: EmitEventInput): Promise<string> {
    const hasClient = maybeInput !== undefined;
    const client = hasClient ? (clientOrInput as DbClient) : this.prisma;
    const input = hasClient ? maybeInput! : (clientOrInput as EmitEventInput);

    const id = `evt_${randomUUID()}`;
    const source = input.channel
      ? `umg://channel/${input.channel}/account/${input.accountId ?? 'none'}/endpoint/${input.endpointId ?? 'none'}`
      : 'umg://system';
    const envelope = {
      specversion: '1.0',
      id,
      type: input.type,
      source,
      subject: input.aggregateId ? `${input.type.split('.')[0]}/${input.aggregateId}` : undefined,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      channel: input.channel ?? undefined,
      account_id: input.accountId ?? null,
      endpoint_id: input.endpointId ?? null,
      event_version: '1.0',
      data: input.data,
    };

    const row = {
      id,
      eventType: input.type,
      aggregateId: input.aggregateId ?? null,
      channelType: (input.channel ?? null) as never,
      accountId: input.accountId ?? null,
      endpointId: input.endpointId ?? null,
      payload: envelope as never,
    };

    if (input.dedupKey) {
      await client.messageEvent.upsert({
        where: { dedupKey: input.dedupKey },
        create: { ...row, dedupKey: input.dedupKey },
        update: {},
      });
    } else {
      await client.messageEvent.create({ data: row });
    }
    return id;
  }
}
