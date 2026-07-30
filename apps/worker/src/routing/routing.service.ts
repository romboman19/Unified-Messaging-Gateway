import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClient, Prisma, MessageEvent, RoutingRule } from '@umg/database';

export interface WebhookDeliverJobData {
  deliveryId: string;
}

function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = current[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Projects only the selected dot-paths from the source object. */
function projectFields(source: Record<string, unknown>, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const value = getPath(source, path);
    if (value !== undefined) setPath(out, path, value);
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/**
 * Renders a template object against the event envelope. Pure string
 * replacement, no eval and no template engine: a string consisting of one
 * {{dot.path}} placeholder is replaced with the raw value (preserving type),
 * embedded placeholders are replaced with the value (JSON-stringified when
 * the value is not a string).
 */
export function renderTemplate(template: unknown, envelope: unknown): unknown {
  if (typeof template === 'string') {
    const exact = template.match(/^\{\{([^{}]+)\}\}$/);
    if (exact) {
      const value = getPath(envelope, exact[1].trim());
      return value === undefined ? null : value;
    }
    return template.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) => {
      const value = getPath(envelope, path.trim());
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }
  if (Array.isArray(template)) {
    return template.map((item) => renderTemplate(item, envelope));
  }
  if (template !== null && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      out[key] = renderTemplate(value, envelope);
    }
    return out;
  }
  return template;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    @InjectQueue('webhook.deliver') private readonly webhookQueue: Queue,
  ) {}

  /**
   * Matches a canonical event against enabled routing rules (ascending
   * priority) and creates a pending webhook delivery per enabled destination,
   * then enqueues a webhook.deliver BullMQ job for each delivery.
   */
  async matchAndDispatch(event: MessageEvent): Promise<void> {
    const rules = await this.prisma.routingRule.findMany({
      where: { enabled: true },
      orderBy: { priority: 'asc' },
      include: { destinations: { include: { destination: true } } },
    });

    const envelope = (event.payload ?? {}) as Record<string, unknown>;

    for (const rule of rules) {
      const match = this.ruleMatches(rule, event, envelope);
      if (!match.matched) {
        this.logger.debug(`Rule ${rule.name} skipped for event ${event.id}: ${match.reason}`);
        continue;
      }

      const ruleSelector = toStringArray(rule.fieldSelector);
      const rulePayload: Record<string, unknown> =
        ruleSelector.length > 0 ? projectFields(envelope, ruleSelector) : envelope;

      for (const link of rule.destinations) {
        const destination = link.destination;
        if (!destination.enabled) {
          this.logger.debug(
            `Destination ${destination.name} disabled, skipped for event ${event.id}`,
          );
          continue;
        }

        const destSelector = toStringArray(destination.fieldSelector);
        const destPayload: Record<string, unknown> =
          destSelector.length > 0 ? projectFields(rulePayload, destSelector) : rulePayload;

        const body =
          destination.templateJson !== null && destination.templateJson !== undefined
            ? renderTemplate(destination.templateJson, destPayload)
            : destPayload;

        const delivery = await this.prisma.webhookDelivery.create({
          data: {
            eventId: event.id,
            destinationId: destination.id,
            status: 'pending',
            maxAttempts: 5,
            requestJson: body as Prisma.InputJsonValue,
          },
        });

        const jobData: WebhookDeliverJobData = { deliveryId: delivery.id };
        await this.webhookQueue.add('deliver', jobData, { jobId: delivery.id });
        this.logger.log(
          `Delivery ${delivery.id} created for event ${event.id} -> destination ${destination.name}`,
        );
      }
    }
  }

  private ruleMatches(
    rule: RoutingRule,
    event: MessageEvent,
    envelope: Record<string, unknown>,
  ): { matched: boolean; reason?: string } {
    const eventTypes = toStringArray(rule.eventTypes);
    if (!eventTypes.includes(event.eventType)) {
      return { matched: false, reason: `event type ${event.eventType} not in rule list` };
    }

    const filters = (rule.filters ?? {}) as Record<string, unknown>;
    for (const [key, expected] of Object.entries(filters)) {
      let actual: unknown;
      switch (key) {
        case 'channelType':
          actual = event.channelType;
          break;
        case 'accountId':
          actual = event.accountId;
          break;
        case 'endpointId':
          actual = event.endpointId;
          break;
        case 'direction':
          actual = getPath(envelope, 'data.message.direction');
          break;
        default:
          this.logger.warn(`Unknown routing filter key "${key}" in rule ${rule.name}`);
          return { matched: false, reason: `unsupported filter key ${key}` };
      }
      if (actual !== expected) {
        return { matched: false, reason: `filter ${key}: expected ${String(expected)}, got ${String(actual)}` };
      }
    }
    return { matched: true };
  }
}
