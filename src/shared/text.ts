// Text normalization, digests and excerpts. Pure functions; no DOM access.

const SPACE_LIKE = new RegExp('[\\u00a0\\u2007\\u202f]', 'g');
const ZERO_WIDTH = new RegExp('[\\u200b\\u200c\\u200d\\ufeff]', 'g');

/**
 * Normalizes extracted message text so digests are stable across re-renders:
 * unifies newlines and non-breaking spaces, removes zero-width characters,
 * collapses horizontal whitespace, trims each line and limits blank-line runs.
 * Letter case and wording are kept.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(SPACE_LIKE, ' ')
    .replace(ZERO_WIDTH, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Non-cryptographic 64-bit content digest (two 32-bit multiplicative hash lanes),
 * returned as 16 hex characters. Used only to recognize the same message text
 * again; it is not a security boundary.
 */
export function digest(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Truncates at a code point boundary and appends an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** First non-empty line, truncated for compact display. */
export function excerpt(text: string, max = 90): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return truncate(line.trim(), max);
}

export const PREFIX_LENGTH = 160;

/** Leading slice of normalized text stored with anchors to detect changed messages. */
export function anchorPrefix(text: string): string {
  return Array.from(text).slice(0, PREFIX_LENGTH).join('');
}

/**
 * Case-folds without changing string length, so match offsets found in the
 * folded string are valid in the original. Characters whose lower-case form has
 * a different length (rare) are left unchanged.
 */
export function foldCase(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}
