/**
 * Tokenizer for the rules classifier. Deliberately small and predictable:
 *   - lower-case; "K&B", "T&M", "FF&E" collapse to one token (kb, tm, ffe); a free-standing "&" is "and"
 *   - hyphens, slashes and punctuation split tokens ("design-build" → design build)
 *   - light plural stemming only (techs → tech, agencies → agency, boxes → box); no -ing/-ed stemming,
 *     so "flooring" never collides with "shop floor"
 */

export interface Token {
  /** stemmed, lower-case form used for matching */
  stem: string;
  /** the token as the user wrote it (for evidence quotes) */
  raw: string;
}

export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (/\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(xes|ches|shes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (/(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function normalize(text: string): string {
  return text
    .replace(/(\w)&(\w)/g, '$1$2')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenizeRaw(text: string): Token[] {
  const norm = normalize(text);
  if (!norm) return [];
  return norm.split(/\s+/).map((raw) => ({ raw, stem: stem(raw) }));
}

/** Stemmed tokens only. */
export function tokenize(text: string): string[] {
  return tokenizeRaw(text).map((t) => t.stem);
}

/** Collapse whitespace and case for substring checks of verbatim quotes. */
export function normalizeForQuote(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}
