import { z } from 'zod';
import { ChannelTypeSchema, MessageDirectionSchema } from './channels';

export const MessageTypeSchema = z.enum([
  'text',
  'image',
  'audio',
  'voice',
  'video',
  'document',
  'sticker',
  'location',
  'contact',
  'reaction',
  'reply',
  'interactive',
  'poll',
  'system',
  'unknown',
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageStatusSchema = z.enum([
  'created',
  'scheduled',
  'queued',
  'dispatching',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
  'expired',
  'unknown',
  'received',
  'assembling',
  'incomplete',
  'processed',
  'forwarded',
  'forward_failed',
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const PhoneInfoSchema = z.object({
  raw: z.string(),
  e164: z.string(),
  display: z.string(),
});
export type PhoneInfo = z.infer<typeof PhoneInfoSchema>;

export const CanonicalAttachmentSchema = z.object({
  id: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string().optional(),
});
export type CanonicalAttachment = z.infer<typeof CanonicalAttachmentSchema>;

export const CanonicalMessageSchema = z.object({
  id: z.string(),
  direction: MessageDirectionSchema,
  channel: ChannelTypeSchema,
  accountId: z.string(),
  endpointId: z.string(),
  conversationId: z.string().nullable(),
  externalMessageId: z.string().nullable(),
  type: MessageTypeSchema,
  from: PhoneInfoSchema.nullable(),
  to: PhoneInfoSchema.nullable(),
  content: z.record(z.unknown()),
  attachments: z.array(CanonicalAttachmentSchema).default([]),
  replyToMessageId: z.string().nullable(),
  status: MessageStatusSchema,
  receivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
  rawPayload: z.record(z.unknown()).default({}),
});
export type CanonicalMessage = z.infer<typeof CanonicalMessageSchema>;
