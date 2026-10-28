/**
 * Long-SMS reassembly helpers for transports that hand us concatenated SMS
 * without the UDH (part number / total) — the GoIP SMS Server does exactly
 * that. Two failure modes are seen in the wild:
 *
 *   1. Parts forwarded one by one, out of order:
 *        "…але місце " (67) · "дразу отримаєте…" (31) · "займають :) …і ви о" (67)
 *   2. Parts glued by the gateway in *arrival* order, so the short final part
 *      lands in the middle:
 *        "…пакета на 1 м" + "//go.vodafone.ua/Home" + "ісяць. Щоб…https:"
 *
 * Without a UDH the only signal is length: every part except the last fills
 * the segment exactly — 67 UTF-16 units for UCS-2, 153 septets for GSM-7.
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€\f';

/** Payload capacity of one part of a concatenated SMS. */
export const UCS2_PART_UNITS = 67;
export const GSM7_PART_SEPTETS = 153;

/**
 * Per-character cost in segment units, plus the part size that applies.
 * GSM-7 is used only when every character fits it; anything else (Cyrillic,
 * emoji) forces the whole message into UCS-2.
 */
function measure(text: string): { costs: number[]; part: number } {
  const chars = [...text];
  const gsm = chars.every((c) => GSM7_BASIC.includes(c) || GSM7_EXT.includes(c));
  if (gsm) {
    return { costs: chars.map((c) => (GSM7_EXT.includes(c) ? 2 : 1)), part: GSM7_PART_SEPTETS };
  }
  // UCS-2 counts UTF-16 code units, so an astral character costs two.
  return { costs: chars.map((c) => c.length), part: UCS2_PART_UNITS };
}

/**
 * True when the text is a whole number of full parts — a non-final part, or
 * several parts glued without their final one. Either way more is coming.
 */
export function looksLikeIncompletePart(text: string): boolean {
  if (!text) return false;
  const { costs, part } = measure(text);
  const units = costs.reduce((a, b) => a + b, 0);
  return units > 0 && units % part === 0;
}

/** Character offsets of the given unit offsets, or null if one splits a char. */
function unitToCharIndex(costs: number[], units: number[]): number[] | null {
  const out: number[] = [];
  let u = 0;
  let i = 0;
  for (const target of [...units].sort((a, b) => a - b)) {
    while (u < target && i < costs.length) u += costs[i++];
    if (u !== target) return null;
    out.push(i);
  }
  return out;
}

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * Whether two characters meeting across a seam look like a mis-join: a word
 * switching alphabet mid-way ("Homeісяць"), or a letter running straight into
 * a scheme-less URL ("м//go.").
 */
function suspicious(before: string, after: string): boolean {
  const a = [...before].pop() ?? '';
  const b = [...after][0] ?? '';
  if ((CYRILLIC.test(a) && LATIN.test(b)) || (LATIN.test(a) && CYRILLIC.test(b))) return true;
  if (/\p{L}/u.test(a) && after.startsWith('//')) return true;
  return false;
}

/**
 * Repairs failure mode 2: moves a short final part that was glued into the
 * middle back to the end. Returns the text unchanged unless exactly one
 * placement is both clearly wrong where it is and clean once moved — a guess
 * that rewrites a correct message would be worse than leaving it.
 */
export function repairGluedParts(text: string): string {
  const { costs, part } = measure(text);
  const units = costs.reduce((a, b) => a + b, 0);
  const short = units % part;
  const parts = Math.ceil(units / part);
  if (parts < 2 || short === 0) return text;
  const chars = [...text];

  const fixes: string[] = [];
  // k = index of the slot the short part occupies; k = parts-1 is "already last".
  for (let k = 0; k < parts - 1; k++) {
    const idx = unitToCharIndex(costs, [k * part, k * part + short]);
    if (!idx) continue;
    const [start, end] = idx;
    const head = chars.slice(0, start).join('');
    const tail = chars.slice(start, end).join('');
    const rest = chars.slice(end).join('');
    const wrongNow = suspicious(tail, rest) && (k === 0 || suspicious(head, tail));
    const cleanAfter = !suspicious(head, rest) && !suspicious(rest, tail);
    if (wrongNow && cleanAfter) fixes.push(head + rest + tail);
  }
  return fixes.length === 1 ? fixes[0] : text;
}

/**
 * Orders buffered parts (in arrival order) into one message: full parts keep
 * their arrival order, and the one short part — the final segment — goes
 * last. Any further short texts are unrelated messages from the same sender
 * and are returned separately.
 */
export function assembleParts<T extends { text: string }>(
  parts: T[],
): { combined: T[]; leftovers: T[] } {
  const full = parts.filter((p) => looksLikeIncompletePart(p.text));
  const shorts = parts.filter((p) => !looksLikeIncompletePart(p.text));
  return { combined: [...full, ...shorts.slice(0, 1)], leftovers: shorts.slice(1) };
}
