import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from '@umg/database';

export interface RaiseAlertParams {
  fingerprint: string;
  ruleKey: string;
  severity: string;
  title: string;
  message: string;
  payload: unknown;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  /**
   * Raises (or refreshes) a firing alert identified by fingerprint. The same
   * incident updates lastSeenAt/payload instead of creating duplicate rows.
   */
  async raise(params: RaiseAlertParams): Promise<void> {
    const existing = await this.prisma.alert.findFirst({
      where: { fingerprint: params.fingerprint, status: 'firing' },
    });
    if (existing) {
      await this.prisma.alert.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          payloadJson: (params.payload ?? {}) as Prisma.InputJsonValue,
        },
      });
      this.logger.debug(`Alert refreshed: ${params.fingerprint}`);
      return;
    }
    await this.prisma.alert.create({
      data: {
        fingerprint: params.fingerprint,
        ruleKey: params.ruleKey,
        severity: params.severity,
        title: params.title,
        message: params.message,
        payloadJson: (params.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Alert raised: ${params.fingerprint} (${params.severity})`);
  }
}
