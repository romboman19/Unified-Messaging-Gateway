// Canonical event types (spec §15.2, packages/contracts/src/routing.ts).
// Duplicated locally because apps/web does not depend on @umg/contracts.
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

export type EventTypeName = (typeof EVENT_TYPES)[number];
