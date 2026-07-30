import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient, AlertStatus } from '@umg/database';
import { AuditService } from '../common/audit.service';

export interface AlertListFilters {
  status?: AlertStatus;
  take: number;
  skip: number;
}

export interface RaiseAlertInput {
  fingerprint: string;
  ruleKey: string;
  severity: string;
  title: string;
  message: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class AlertsService {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list(filters: AlertListFilters) {
    const where = { status: filters.status };
    const [items, count] = await Promise.all([
      this.prisma.alert.findMany({
        where,
        take: filters.take,
        skip: filters.skip,
        orderBy: { lastSeenAt: 'desc' },
      }),
      this.prisma.alert.count({ where }),
    ]);
    return { items, count };
  }

  async resolve(id: string, actorId: string | null) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('Алерт не знайдено.');
    if (alert.status === 'resolved') return alert;
    const updated = await this.prisma.alert.update({
      where: { id },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
    await this.audit.log(actorId, 'alert.resolved', 'alert', id, { status: alert.status }, {
      status: updated.status,
    });
    return updated;
  }

  async listRules() {
    const items = await this.prisma.alertRule.findMany({ orderBy: { key: 'asc' } });
    return { items, count: items.length };
  }

  async updateRule(
    key: string,
    data: { enabled?: boolean; configJson?: Record<string, unknown> },
    actorId: string | null,
  ) {
    const before = await this.prisma.alertRule.findUnique({ where: { key } });
    if (!before) throw new NotFoundException('Правило алертів не знайдено.');
    const updated = await this.prisma.alertRule.update({
      where: { key },
      data: {
        enabled: data.enabled,
        configJson: data.configJson ? (data.configJson as never) : undefined,
      },
    });
    await this.audit.log(actorId, 'alert_rule.updated', 'alert_rule', key, before, {
      key: updated.key,
      enabled: updated.enabled,
    });
    return updated;
  }

  /**
   * Raise an alert: if a firing alert with the same fingerprint already exists,
   * bump lastSeenAt; otherwise create a new firing alert.
   */
  async raise(input: RaiseAlertInput) {
    const existing = await this.prisma.alert.findFirst({
      where: { fingerprint: input.fingerprint, status: 'firing' },
    });
    if (existing) {
      return this.prisma.alert.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          message: input.message,
          payloadJson: (input.payload ?? existing.payloadJson) as never,
        },
      });
    }
    return this.prisma.alert.create({
      data: {
        fingerprint: input.fingerprint,
        ruleKey: input.ruleKey,
        severity: input.severity,
        status: 'firing',
        title: input.title,
        message: input.message,
        payloadJson: (input.payload ?? {}) as never,
      },
    });
  }
}
