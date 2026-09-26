export interface SmsGroupingSettings {
  enabled: boolean;
  idleSeconds: number;
  maxSeconds: number;
}

export const SMS_GROUPING_DEFAULTS: SmsGroupingSettings = {
  enabled: false, idleSeconds: 25, maxSeconds: 90,
};

/** Validate at the API boundary; absence means opt-out for existing SIMs. */
export function smsGroupingSettings(value: unknown): SmsGroupingSettings {
  if (value === undefined) return { ...SMS_GROUPING_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('smsGrouping має бути об’єктом.');
  }
  const v = value as Record<string, unknown>;
  const enabled = v.enabled ?? false;
  const idleSeconds = v.idleSeconds ?? 25;
  const maxSeconds = v.maxSeconds ?? 90;
  if (typeof enabled !== 'boolean' || typeof idleSeconds !== 'number' ||
      typeof maxSeconds !== 'number' || !Number.isInteger(idleSeconds) ||
      !Number.isInteger(maxSeconds) || idleSeconds < 5 || idleSeconds > 120 ||
      maxSeconds < idleSeconds || maxSeconds > 300) {
    throw new Error('smsGrouping: enabled — boolean; очікування 5–120 с, максимум від очікування до 300 с.');
  }
  return { enabled, idleSeconds, maxSeconds };
}

export function smsGroupDeadline(now: Date, expiresAt: Date, idleSeconds: number): Date {
  return new Date(Math.min(now.getTime() + idleSeconds * 1000, expiresAt.getTime()));
}
