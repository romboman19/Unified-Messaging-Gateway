import { z } from 'zod';
import { MessageTypeSchema } from './messages';
import { ChannelTypeSchema } from './channels';

export const SendMessageRequestSchema = z.object({
  channel: ChannelTypeSchema,
  accountId: z.string().uuid(),
  endpointId: z.string().uuid(),
  to: z.string().min(1),
  type: MessageTypeSchema,
  content: z.record(z.unknown()),
  attachments: z.array(z.string().uuid()).default([]),
  replyToMessageId: z.string().uuid().nullable().default(null),
  scheduledAt: z.string().datetime().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  scheduledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
