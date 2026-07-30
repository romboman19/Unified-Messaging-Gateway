import { z } from 'zod';

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertStatusSchema = z.enum(['firing', 'resolved']);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

export const AlertDtoSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string(),
  ruleKey: z.string(),
  severity: AlertSeveritySchema,
  status: AlertStatusSchema,
  title: z.string(),
  message: z.string(),
  payload: z.record(z.unknown()).default({}),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
export type AlertDto = z.infer<typeof AlertDtoSchema>;

export const AlertRuleDtoSchema = z.object({
  key: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});
export type AlertRuleDto = z.infer<typeof AlertRuleDtoSchema>;
