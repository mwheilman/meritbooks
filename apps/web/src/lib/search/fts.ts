/**
 * Lexical full-text-search helpers for the SEARCH lane (matrix modality M13).
 *
 * This is the "real retrieval" upgrade over the old keyword-only `.ilike`
 * substring scan. Two pure, dependency-free pieces:
 *
 *  1. `buildTsQuery` — turns the deterministic parse (terms + reference-number
 *     tokens + quoted phrases) into a Postgres `to_tsquery`-compatible string
 *     with prefix matching (`:*`) and phrase adjacency (`<->`). The retrieval
 *     layer hands this to PostgREST `.textSearch(col, q, { config: 'english' })`,
 *     which runs it against a GIN-indexed `search_tsv` generated column. No model
 *     ever authors this string — it is built mechanically from the parse.
 *
 *  2. `buildHeadline` — a ts_headline-equivalent snippet builder. It scans the
 *     record's OWN text fields for the matched needles and returns highlighted
 *     spans, so every hit shows the user *why* it matched, grounded in real data
 *     (never fabricated). Kept in JS (rather than SQL ts_headline) so it works
 *     identically on the FTS path and on the `.ilike` degrade-safe fallback.
 */

import type { HeadlineSegment, ParsedQuery } from './types';

/** Split a token into lowercase alphanumeric lexemes (drops punctuation). */
function lexemesOf(token: string): string[] {
  return token.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * A single token → an AND of prefix lexemes. Reference numbers like `INV-1042`
 * become `inv:* & 1042:*` (both lexemes are present in the tsvector regardless
 * of position, so this is more robust than forcing adjacency for hyphenated ids).
 */
function conjunctFromToken(token: string): string | null {
  const words = lexemesOf(token);
  if (words.length === 0) return null;
  return words.map((w) => `${w}:*`).join(' & ');
}

/** A quoted phrase → an ordered adjacency match, prefix on the final lexeme. */
function conjunctFromPhrase(phrase: string): string | null {
  const words = lexemesOf(phrase);
  if (words.length === 0) return null;
  if (words.length === 1) return `${words[0]}:*`;
  const parts = words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w));
  return `(${parts.join(' <-> ')})`;
}

/**
 * Build a `to_tsquery`-safe string from the deterministic parse. Quoted phrases
 * match as ordered adjacency; every other term/number-token is AND-ed as a
 * prefix lexeme. Returns null when there is no lexical constraint (caller then
 * relies on amount/date filters, or skips the type entirely).
 *
 * Output alphabet is restricted to `[a-z0-9]`, `:*`, `<->`, `&`, parens and
 * spaces, so it is always a valid tsquery — never a SQL-injection surface (it is
 * passed as the `query` argument to PostgREST `.textSearch`, not interpolated).
 */
export function buildTsQuery(
  parsed: Pick<ParsedQuery, 'raw' | 'terms' | 'numberTokens'>,
): string | null {
  const conjuncts: string[] = [];
  const seen = new Set<string>();
  const push = (c: string | null): void => {
    if (c && !seen.has(c)) {
      seen.add(c);
      conjuncts.push(c);
    }
  };

  // Explicit quoted phrases first (user asked for an ordered match).
  const phraseRe = /"([^"]+)"/g;
  let pm: RegExpExecArray | null;
  while ((pm = phraseRe.exec(parsed.raw)) !== null) {
    push(conjunctFromPhrase(pm[1]));
  }

  for (const tok of [...parsed.numberTokens, ...parsed.terms]) {
    push(conjunctFromToken(tok));
  }

  return conjuncts.length > 0 ? conjuncts.join(' & ') : null;
}

/** The needles a headline should highlight: number tokens + free-text terms. */
export function headlineNeedles(
  parsed: Pick<ParsedQuery, 'terms' | 'numberTokens'>,
): string[] {
  const out: string[] = [];
  for (const raw of [...parsed.numberTokens, ...parsed.terms]) {
    const t = raw.toLowerCase().trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split a slice into highlighted / plain segments for the given needles. */
function highlightSegments(text: string, needles: string[]): HeadlineSegment[] {
  const escaped = needles
    .map(escapeRegExp)
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length); // prefer longer matches
  if (escaped.length === 0) return [{ text, hit: false }];

  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const segments: HeadlineSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), hit: false });
    segments.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex += 1; // guard against zero-width
  }
  if (last < text.length) segments.push({ text: text.slice(last), hit: false });
  return segments;
}

const HEADLINE_BEFORE = 60;
const HEADLINE_AFTER = 110;

/**
 * Build a grounded, highlighted headline from a record's own text fields. Picks
 * the first field that actually contains a needle, windows around the first hit,
 * and returns highlighted spans. Returns null when nothing matched (e.g. the row
 * came back on an amount/date filter alone) so the caller can fall back to its
 * static snippet.
 */
export function buildHeadline(
  values: Array<string | null | undefined>,
  needles: string[],
): HeadlineSegment[] | null {
  if (needles.length === 0) return null;
  const lowered = needles.map((n) => n.toLowerCase());

  for (const raw of values) {
    if (!raw) continue;
    const text = raw;
    const hay = text.toLowerCase();

    let firstIdx = -1;
    for (const n of lowered) {
      const i = hay.indexOf(n);
      if (i >= 0 && (firstIdx < 0 || i < firstIdx)) firstIdx = i;
    }
    if (firstIdx < 0) continue;

    const start = Math.max(0, firstIdx - HEADLINE_BEFORE);
    const end = Math.min(text.length, firstIdx + HEADLINE_AFTER);
    const slice = text.slice(start, end);
    const segments = highlightSegments(slice, needles);
    if (start > 0) segments.unshift({ text: '…', hit: false });
    if (end < text.length) segments.push({ text: '…', hit: false });
    return segments;
  }
  return null;
}
