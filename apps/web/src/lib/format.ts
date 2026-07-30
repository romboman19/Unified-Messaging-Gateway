export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('uk-UA');
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.slice(0, 8);
}

export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function apiError(err: unknown, fallback: string): string {
  const anyErr = err as { response?: { data?: { message?: unknown; error?: { message?: unknown } } } };
  const msg = anyErr?.response?.data?.message ?? anyErr?.response?.data?.error?.message;
  if (Array.isArray(msg)) return msg.join(', ');
  if (typeof msg === 'string') return msg;
  return fallback;
}
