/**
 * Keys whose values are credentials. Matched case-insensitively against the
 * whole key, so `password`, `smtpPass`, `botToken`, `secretEnc` and
 * `encryptedConfig` all qualify while `tokenId` or `passwordChangedAt` do not.
 */
const SECRET_KEY =
  /^(encryptedConfig|.*(secret|password|pass|token|apiKey|api_key|secretEnc|privateKey|credentials?))$/i;

const MASK = '***';

/**
 * Deep copy of `value` with every credential-looking field masked.
 *
 * Audit rows snapshot whole entities, and those entities carry sidecar
 * passwords and webhook secrets in their config blobs. The audit log is
 * readable with a Bearer token, so nothing secret may reach it.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' ? MASK : redactSecrets(v);
  }
  return out;
}
