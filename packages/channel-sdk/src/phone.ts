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
  // Strip non-digits. Alphanumeric senders ("PrivatBank") have none, or only a
  // few, and are not phone numbers at all.
  let digits = trimmed.replace(/\D+/g, '');
  if (/[A-Za-z]/.test(trimmed)) return null;
  // "00" is the international dialling prefix: 00380… is +380….
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Short codes ("7000", "111") have no E.164 form; inventing one would key
  // their threads on a number that does not exist.
  if (digits.length < 9 || digits.length > 15) return null;
  const cc = defaultCountry.replace(/^\+/, '');
  // National format with the trunk prefix: 0671112233 → +380671112233. Without
  // this the result was +3800671112233, which matches nothing we send to, so
  // a carrier that reports senders nationally split every thread in two.
  if (digits.startsWith('0') && digits.length === 10) {
    return `+${cc}${digits.slice(1)}`;
  }
  // If the digits already start with the country code (assumed to be 3 digits
  // when not prefixed with `+`), keep as-is.
  if (digits.length >= 11) {
    return `+${digits}`;
  }
  // Otherwise prepend the default country code without its leading `+`.
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
