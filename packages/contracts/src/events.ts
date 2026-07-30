import { z } from 'zod';

export const CloudEventEnvelopeSchema = z.object({
  specversion: z.literal('1.0'),
  id: z.string(),
  type: z.string(),
  source: z.string(),
  subject: z.string(),
  time: z.string().datetime(),
  datacontenttype: z.literal('application/json'),
  channel: z.string(),
  accountId: z.string(),
  endpointId: z.string(),
  eventVersion: z.literal('1.0'),
  data: z.record(z.unknown()),
});
export type CloudEventEnvelope = z.infer<typeof CloudEventEnvelopeSchema>;

export const EventTypeSchema = z.enum([
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
  'webhook.delivery.failed',
  'webhook.dead_lettered',
  'queue.backlog',
]);
export type EventType = z.infer<typeof EventTypeSchema>;
