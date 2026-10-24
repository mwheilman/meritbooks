/**
 * Taxpayer-ID redaction (security review H4). CLIENT-SAFE and pure.
 *
 * Masks SSN / ITIN / EIN-shaped strings so a TIN never lands in document_intelligence /
 * document_proposals / ai_decisions text, never goes back to the browser, and never goes
 * into an AI prompt. Keeps the last four digits ("***-**-1234") — enough to tell two
 * vendors apart, useless to anyone else.
 *
 * Deliberately conservative about what it touches:
 *   always    ddd-dd-dddd            (SSN / ITIN — a phone number is 3-3-4, a date 4-2-2)
 *             dd-ddddddd             (EIN)
 *   context   a 9-digit run (spaces / dashes allowed) within ~30 characters after a
 *             label — SSN, social security, TIN, taxpayer identification, EIN, FEIN,
 *             ITIN, tax ID, employer identification number. Without a label, a bare
 *             9-digit run (a routing number, an amount) is left alone.
 * Money ("$123,456,789.00" has commas), ISO dates and phone numbers are not shapes above.
 */

const SSN_DASHED = /(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)/g;
const EIN_DASHED = /(?<!\d)(\d{2})-(\d{7})(?!\d)/g;
const LABEL = String.raw`(?:ssn|social\s+security(?:\s+(?:number|no\.?|#))?|itin|fein|ein|tin|taxpayer\s+identification(?:\s+(?:number|no\.?))?|taxpayer\s+id(?:\s+(?:number|no\.?))?|tax\s+id(?:entification)?(?:\s+(?:number|no\.?))?|employer\s+identification(?:\s+(?:number|no\.?))?)`;
const LABELLED_RUN = new RegExp(String.raw`(?<![a-z])(${LABEL})(?![a-z])([^0-9\n]{0,30}?)((?:\d[ -]?){8}\d)(?!\d)`, 'gi');

const last4 = (digits: string): string => digits.replace(/\D/g, '').slice(-4);

/** Mask every TIN-shaped string in `s` (keeps the last four digits). */
export function redactTin(s: string): string {
  if (!s || !/\d/.test(s)) return s;
  return s
    .replace(LABELLED_RUN, (_m, label: string, gap: string, run: string) => {
      const d = run.replace(/\D/g, '');
      if (d.length !== 9) return `${label}${gap}${run}`;
      return `${label}${gap}*****${last4(d)}`;
    })
    .replace(SSN_DASHED, (_m, _a: string, _b: string, c: string) => `***-**-${c}`)
    .replace(EIN_DASHED, (_m, _a: string, b: string) => `**-***${b.slice(-4)}`);
}

/** Does `s` carry a TIN-shaped string? */
export function containsTin(s: string | null | undefined): boolean {
  if (!s) return false;
  return redactTin(s) !== s;
}

/** Recursively redact every string inside a JSON-like value (objects, arrays). */
export function redactDeep<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return redactTin(v);
  if (depth > 20 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
  if (v instanceof Date) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
  return out;
}

/** Redact the named fields of a row / patch (other fields — ids, numbers — untouched). */
export function redactFields<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T {
  let out: T | null = null;
  for (const k of keys) {
    if (!(k in row)) continue;
    const before = row[k];
    const after = redactDeep(before);
    if (after !== before) {
      out = out ?? { ...row };
      (out as Record<string, unknown>)[k] = after;
    }
  }
  return out ?? row;
}
