import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { redactSecrets } from '../common/redact';

@Injectable()
export class AuditLogsService {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async list(opts: { take: number; skip: number }) {
    const [items, count] = await Promise.all([
      this.prisma.auditLog.findMany({
        take: opts.take,
        skip: opts.skip,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, username: true } } },
      }),
      this.prisma.auditLog.count(),
    ]);
    // Rows written before redaction existed still hold plaintext credentials.
    return {
      items: items.map((row) => ({
        ...row,
        beforeJson: redactSecrets(row.beforeJson),
        afterJson: redactSecrets(row.afterJson),
      })),
      count,
    };
  }

  async listEvents(opts: { type?: string; take: number; skip: number }) {
    const where = { eventType: opts.type };
    const [items, count] = await Promise.all([
      this.prisma.messageEvent.findMany({
        where,
        take: opts.take,
        skip: opts.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.messageEvent.count({ where }),
    ]);
    return { items, count };
  }
}
