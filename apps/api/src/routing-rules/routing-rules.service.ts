import {
  Injectable,
  Inject,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@umg/database';
import { EVENT_TYPES, RoutingRuleFiltersSchema } from '@umg/contracts';
import { AuditService } from '../common/audit.service';

const DESTINATION_SUMMARY = {
  id: true,
  name: true,
  type: true,
  enabled: true,
} as const;

const RULE_INCLUDE = {
  destinations: {
    include: { destination: { select: DESTINATION_SUMMARY } },
  },
} as const;

export interface RoutingRuleInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  eventTypes?: string[];
  filters?: Record<string, unknown>;
  fieldSelector?: string[];
  destinationIds?: string[];
}

@Injectable()
export class RoutingRulesService {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rules = await this.prisma.routingRule.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      include: RULE_INCLUDE,
    });
    return { items: rules.map((r) => this.serialize(r)), count: rules.length };
  }

  async get(id: string) {
    const rule = await this.prisma.routingRule.findUnique({
      where: { id },
      include: RULE_INCLUDE,
    });
    if (!rule) throw new NotFoundException('Правило маршрутизації не знайдено.');
    return this.serialize(rule);
  }

  async create(data: RoutingRuleInput, actorId: string | null) {
    this.validateEventTypes(data.eventTypes ?? []);
    this.validateFilters(data.filters);
    await this.ensureDestinationsExist(data.destinationIds ?? []);

    const rule = await this.prisma.$transaction(async (tx) => {
      const created = await tx.routingRule.create({
        data: {
          name: data.name!,
          enabled: data.enabled ?? true,
          priority: data.priority ?? 100,
          eventTypes: (data.eventTypes ?? []) as never,
          filters: (data.filters ?? {}) as never,
          fieldSelector: (data.fieldSelector ?? []) as never,
        },
      });
      await this.syncDestinationLinks(tx, created.id, data.destinationIds ?? []);
      return tx.routingRule.findUniqueOrThrow({ where: { id: created.id }, include: RULE_INCLUDE });
    });

    await this.audit.log(actorId, 'routing_rule.created', 'routing_rule', rule.id, {}, {
      id: rule.id,
      name: rule.name,
      eventTypes: data.eventTypes,
    });
    return this.serialize(rule);
  }

  async update(id: string, data: RoutingRuleInput, actorId: string | null) {
    const before = await this.get(id);
    if (data.eventTypes) this.validateEventTypes(data.eventTypes);
    if (data.filters) this.validateFilters(data.filters);
    if (data.destinationIds) await this.ensureDestinationsExist(data.destinationIds);

    const rule = await this.prisma.$transaction(async (tx) => {
      await tx.routingRule.update({
        where: { id },
        data: {
          name: data.name,
          enabled: data.enabled,
          priority: data.priority,
          eventTypes: data.eventTypes ? (data.eventTypes as never) : undefined,
          filters: data.filters ? (data.filters as never) : undefined,
          fieldSelector: data.fieldSelector ? (data.fieldSelector as never) : undefined,
        },
      });
      if (data.destinationIds) {
        await tx.ruleDestinationLink.deleteMany({ where: { ruleId: id } });
        await this.syncDestinationLinks(tx, id, data.destinationIds);
      }
      return tx.routingRule.findUniqueOrThrow({ where: { id }, include: RULE_INCLUDE });
    });

    await this.audit.log(actorId, 'routing_rule.updated', 'routing_rule', id, before, {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
    });
    return this.serialize(rule);
  }

  async delete(id: string, actorId: string | null) {
    const before = await this.get(id);
    await this.prisma.routingRule.delete({ where: { id } });
    await this.audit.log(actorId, 'routing_rule.deleted', 'routing_rule', id, before, {});
    return { ok: true };
  }

  private validateEventTypes(eventTypes: string[]): void {
    const allowed = new Set<string>(EVENT_TYPES);
    const invalid = eventTypes.filter((t) => !allowed.has(t));
    if (invalid.length > 0) {
      throw new UnprocessableEntityException(
        `Невідомі типи подій: ${invalid.join(', ')}. Перевірте список підтримуваних подій.`,
      );
    }
  }

  private validateFilters(filters: Record<string, unknown> | undefined): void {
    if (!filters) return;
    const parsed = RoutingRuleFiltersSchema.safeParse(filters);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        'Некоректні фільтри правила маршрутизації. Перевірте channelType, accountId, endpointId, direction, severity.',
      );
    }
  }

  private async ensureDestinationsExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.webhookDestination.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size) {
      throw new UnprocessableEntityException('Одне або кілька призначень (destinations) не існують.');
    }
  }

  private async syncDestinationLinks(
    tx: Prisma.TransactionClient,
    ruleId: string,
    destinationIds: string[],
  ): Promise<void> {
    const unique = [...new Set(destinationIds)];
    for (const destinationId of unique) {
      await tx.ruleDestinationLink.create({ data: { ruleId, destinationId } });
    }
  }

  private serialize(
    rule: Prisma.RoutingRuleGetPayload<{ include: typeof RULE_INCLUDE }>,
  ) {
    const { destinations, ...rest } = rule;
    return {
      ...rest,
      destinations: destinations.map((link) => link.destination),
    };
  }
}
