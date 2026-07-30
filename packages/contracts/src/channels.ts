import { z } from 'zod';

export const ChannelTypeSchema = z.enum(['sms', 'whatsapp', 'signal', 'mock']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const TransportStatusSchema = z.enum(['active', 'inactive', 'degraded', 'disabled']);
export type TransportStatus = z.infer<typeof TransportStatusSchema>;

export const MessageDirectionSchema = z.enum(['inbound', 'outbound']);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;
