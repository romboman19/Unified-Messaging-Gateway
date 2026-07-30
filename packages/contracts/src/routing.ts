import { z } from 'zod';
import { ChannelTypeSchema, MessageDirectionSchema } from './channels';
import { AlertSeveritySchema } from './alerts';

// Canonical event types (spec §15.2).
export const EVENT_TYPES = [
  'message.received',
  'message.assembled',
  'message.queued',
  'message.accepted',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'message.status.unknown',
  'channel.connected',
  'channel.disconnected',
  'channel.degraded',
  'endpoint.enabled',
  'endpoint.disabled',
  'sim.balance.updated',
  'sim.balance.low',
  'sim.balance.recovered',
  'sim.ussd.failed',
  'webhook.delivery.failed',
  'webhook.dead_lettered',
  'queue.backlog',
  'storage.low',
  'system.component.unhealthy',
  'system.component.recovered',
  'media.deleted',
] as const;
export const EventTypeNameSchema = z.enum(EVENT_TYPES);
export type EventTypeName = z.infer<typeof EventTypeNameSchema>;

// Routing rule filters (spec §15.1).
export const RoutingRuleFiltersSchema = z.object({
  channelType: ChannelTypeSchema.optional(),
  accountId: z.string().uuid().optional(),
  endpointId: z.string().uuid().optional(),
  direction: MessageDirectionSchema.optional(),
  severity: AlertSeveritySchema.optional(),
});
export type RoutingRuleFilters = z.infer<typeof RoutingRuleFiltersSchema>;

export const RoutingRuleDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  eventTypes: z.array(EventTypeNameSchema),
  filters: RoutingRuleFiltersSchema.default({}),
  // List of payload field paths to include in the outbound payload; empty = all.
  fieldSelector: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RoutingRuleDto = z.infer<typeof RoutingRuleDtoSchema>;

export const DestinationTypeSchema = z.enum(['webhook', 'email', 'telegram', 'internal_log']);
export type DestinationType = z.infer<typeof DestinationTypeSchema>;

export const WebhookDestinationDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: DestinationTypeSchema,
  enabled: z.boolean().default(true),
  url: z.string().url().nullable(),
  // The HMAC secret itself is never exposed via API; only its presence is reported.
  hasSecret: z.boolean().default(false),
  // email: recipients[]; telegram: botToken/chatId references; webhook: extra headers.
  config: z.record(z.unknown()).default({}),
  fieldSelector: z.array(z.string()).default([]),
  // Advanced JSON template, validated at the API layer.
  template: z.record(z.unknown()).nullable(),
  timeoutMs: z.number().int().positive().default(10000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WebhookDestinationDto = z.infer<typeof WebhookDestinationDtoSchema>;

export const DeliveryStatusSchema = z.enum([
  'pending',
  'delivering',
  'delivered',
  'failed',
  'dlq',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const DeliveryDtoSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  destinationId: z.string().uuid(),
  status: DeliveryStatusSchema,
  attemptCount: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(5),
  nextAttemptAt: z.string().datetime().nullable(),
  lastResponseCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  // Final payload + headers snapshot, kept for test/replay visibility.
  request: z.record(z.unknown()).nullable(),
  response: z.record(z.unknown()).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DeliveryDto = z.infer<typeof DeliveryDtoSchema>;
