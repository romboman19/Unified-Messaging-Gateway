import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { Inject } from '@nestjs/common';
import { redactSecrets } from './redact';

@Injectable()
export class AuditService {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async log(
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action,
        entityType,
        entityId,
        beforeJson: redactSecrets(before ?? {}) as never,
        afterJson: redactSecrets(after ?? {}) as never,
      },
    });
  }
}
