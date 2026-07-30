import { Injectable, NotFoundException } from '@nestjs/common';
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

  async deleteEndpoint(id: string, actorId: string | null) {
    const before = await this.prisma.endpoint.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Endpoint не знайдено.');
    await this.prisma.endpoint.delete({ where: { id } });
    await this.audit.log(actorId, 'endpoint.deleted', 'endpoint', id, before, {});
    return { ok: true };
  }
}
