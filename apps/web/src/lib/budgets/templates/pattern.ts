/**
 * Template account patterns (security review, LOW: no user-supplied RegExp). A template line
 * selects accounts by name / group with a SAFE pattern — never a regular expression:
 *
 *   salar|wage          alternatives separated by "|"
 *   workers*comp        "*" matches any run of characters (incl. none)
 *   everything else     literal, case-insensitive substring ("401(k)" means exactly that)
 *
 * Matching is a linear substring scan (no backtracking engine), and a pattern is capped at
 * 100 characters / 20 alternatives, so a tenant template can't stall the server (ReDoS).
 */

export const PATTERN_MAX_LENGTH = 100;
export const PATTERN_MAX_ALTERNATIVES = 20;

/** Why a pattern is not allowed (null = fine). */
export function patternError(src: string): string | null {
  if (src.length > PATTERN_MAX_LENGTH) return `Keep a pattern to ${PATTERN_MAX_LENGTH} characters.`;
  const alts = src.split('|');
  if (alts.length > PATTERN_MAX_ALTERNATIVES) return `Use at most ${PATTERN_MAX_ALTERNATIVES} alternatives (separated by |).`;
  if (alts.every((a) => a.replace(/\*/g, '').trim() === '')) return 'A pattern needs at least one word.';
  return null;
}

export type Matcher = (text: string) => boolean;

/** Compile a safe pattern; null when it isn't allowed (callers treat that as "matches nothing"). */
export function compilePattern(src: string): Matcher | null {
  if (patternError(src)) return null;
  const alts = src
    .toLowerCase()
    .split('|')
    .map((a) => a.split('*').filter((piece) => piece.length > 0))
    .filter((pieces) => pieces.length > 0);
  return (text: string) => {
    const t = text.toLowerCase();
    return alts.some((pieces) => {
      let at = 0;
      for (const piece of pieces) {
        const i = t.indexOf(piece, at);
        if (i < 0) return false;
        at = i + piece.length;
      }
      return true;
    });
  };
}
