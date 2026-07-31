import type { CanonicalAddress } from './types.js';

/**
 * Lightweight E.164 normalisation helpers.
 *
 * A full implementation lives in the API service and is also re-exported via
 * `@umg/contracts`. We duplicate a minimal variant here so adapters can be
 * self-contained in the worker.
 */

/**
 * Normalise a raw phone string to E.164 when possible.
 * Returns null when the input cannot be confidently normalised.
 */
export function toE164(input: string, defaultCountry = '+380'): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Already in E.164 shape.
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;
  // Strip non-digits.
  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) return null;
  // If the digits already start with the country code (assumed to be 3 digits
  // when not prefixed with `+`), keep as-is.
  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }
  // Otherwise prepend the default country code without its leading `+`.
  const cc = defaultCountry.replace(/^\+/, '');
  return `+${cc}${digits}`;
}

/**
 * Lightweight display formatter (Ukrainian-style grouping). Best-effort only.
 */
export function toDisplay(e164OrRaw: string): string {
  const digits = e164OrRaw.replace(/\D+/g, '');
  if (digits.length === 12 && digits.startsWith('380')) {
    const op = digits.slice(3, 6);
    const a = digits.slice(6, 9);
    const b = digits.slice(9, 11);
    const c = digits.slice(11, 13);
    return `0${op} ${a} ${b} ${c}`;
  }
  return e164OrRaw;
}

export function makeAddress(raw: string, defaultCountry = '+380'): CanonicalAddress {
  const e164 = toE164(raw, defaultCountry);
  return {
    raw,
    e164,
    display: e164 ? toDisplay(e164) : raw,
  };
}
