import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaClient, TransportStatus } from '@umg/database';
import { Inject } from '@nestjs/common';
import { AuditService } from '../common/audit.service';

@Injectable()
export class TransportAccountsService {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.prisma.transportAccount.findMany({
      include: { endpoints: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const account = await this.prisma.transportAccount.findUnique({
      where: { id },
      include: { endpoints: { orderBy: { createdAt: 'desc' } } },
    });
    if (!account) throw new NotFoundException('Акаунт не знайдено.');
    return account;
  }

  async create(
    data: {
      type: string;
      adapter: string;
      name: string;
      status?: TransportStatus;
      config?: Record<string, unknown>;
    },
    actorId: string | null,
  ) {
    const account = await this.prisma.transportAccount.create({
      data: {
        type: data.type as ChannelType,
        adapter: data.adapter,
        name: data.name,
        status: data.status ?? 'active',
        encryptedConfig: (data.config ?? {}) as never,
      },
    });
    await this.audit.log(actorId, 'transport_account.created', 'transport_account', account.id, {}, {
      id: account.id,
      type: account.type,
      adapter: account.adapter,
      name: account.name,
    });
    return account;
  }

  async update(
    id: string,
    data: {
      name?: string;
      status?: TransportStatus;
      config?: Record<string, unknown>;
    },
    actorId: string | null,
  ) {
    const before = await this.get(id);
    const account = await this.prisma.transportAccount.update({
      where: { id },
      data: {
        name: data.name,
        status: data.status,
        encryptedConfig: data.config ? (data.config as never) : undefined,
      },
    });
    await this.audit.log(actorId, 'transport_account.updated', 'transport_account', account.id, before, {
      id: account.id,
      name: account.name,
      status: account.status,
    });
    return account;
  }

  async delete(id: string, actorId: string | null) {
    const before = await this.get(id);
    await this.prisma.transportAccount.delete({ where: { id } });
    await this.audit.log(actorId, 'transport_account.deleted', 'transport_account', id, before, {});
    return { ok: true };
  }

  async createEndpoint(
    accountId: string,
    data: {
      label: string;
      externalId?: string;
      phoneRaw?: string;
      phoneE164?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    },
    actorId: string | null,
  ) {
    await this.get(accountId);
    const endpoint = await this.prisma.endpoint.create({
      data: {
        accountId,
        label: data.label,
        externalId: data.externalId ?? null,
        phoneRaw: data.phoneRaw ?? null,
        phoneE164: data.phoneE164 ?? null,
        enabled: data.enabled ?? true,
        configJson: (data.config ?? {}) as never,
      },
    });
    await this.audit.log(actorId, 'endpoint.created', 'endpoint', endpoint.id, {}, {
      id: endpoint.id,
      accountId,
      label: endpoint.label,
    });
    return endpoint;
  }

  async updateEndpoint(
    id: string,
    data: {
      label?: string;
      externalId?: string;
      phoneRaw?: string;
      phoneE164?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    },
    actorId: string | null,
  ) {
    const before = await this.prisma.endpoint.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Endpoint не знайдено.');
    const endpoint = await this.prisma.endpoint.update({
      where: { id },
      data: {
        label: data.label,
        externalId: data.externalId,
        phoneRaw: data.phoneRaw,
        phoneE164: data.phoneE164,
        enabled: data.enabled,
        configJson: data.config ? (data.config as never) : undefined,
      },
    });
    await this.audit.log(actorId, 'endpoint.updated', 'endpoint', endpoint.id, before, {
      id: endpoint.id,
      label: endpoint.label,
      enabled: endpoint.enabled,
    });
    return endpoint;
  }

  /**
   * Remove a number from the channel.
   *
   * A bare `endpoint.delete()` fails with a foreign-key violation the moment
   * the number has sent or received anything, which is what the admin sees as
   * "delete does nothing". So: refuse by default when history exists, and
   * require `force` to take the history down with it.
   *
   * Detaching the number from the vendor sidecar is the caller's job
   * (`DELETE /endpoints/:id/registration`); deleting a still-linked endpoint
   * would strand the pairing on the sidecar, so we block that too.
   */
  async deleteEndpoint(id: string, actorId: string | null, force = false) {
    const before = await this.prisma.endpoint.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Endpoint не знайдено.');

    if (before.registrationState === 'linked') {
      throw new ConflictException(
        'Номер ще привʼязаний до транспорту. Спочатку відвʼяжіть його, потім видаляйте.',
      );
    }

    const messageCount = await this.prisma.message.count({ where: { endpointId: id } });
    if (messageCount > 0 && !force) {
      throw new ConflictException(
        `У номера є історія повідомлень (${messageCount}). ` +
          'Видаліть разом з історією, якщо вона більше не потрібна.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (messageCount > 0) {
        const messageIds = (
          await tx.message.findMany({ where: { endpointId: id }, select: { id: true } })
        ).map((m) => m.id);
        // Children first — every one of these has a FK onto `messages`.
        await tx.attachment.deleteMany({ where: { messageId: { in: messageIds } } });
        await tx.messageAttempt.deleteMany({ where: { messageId: { in: messageIds } } });
        await tx.messageStatusHistory.deleteMany({ where: { messageId: { in: messageIds } } });
        await tx.message.deleteMany({ where: { endpointId: id } });
      }
      await tx.conversation.deleteMany({ where: { endpointId: id } });
      await tx.endpoint.delete({ where: { id } });
    });

    await this.audit.log(actorId, 'endpoint.deleted', 'endpoint', id, before, {
      deletedMessages: messageCount,
    });
    return { ok: true, deletedMessages: messageCount };
  }
}
