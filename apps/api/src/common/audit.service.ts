import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { Inject } from '@nestjs/common';

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
        beforeJson: (before ?? {}) as never,
        afterJson: (after ?? {}) as never,
      },
    });
  }
}
