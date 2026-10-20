/**
 * Dealer imports — cell parsing (pure, client-safe).
 *
 * Every spreadsheet / AI cell arrives as text. These parsers turn one cell into a typed
 * value or a plain-English problem. Money is integer cents parsed from the STRING (never
 * via float math), rates are basis points, dates are ISO YYYY-MM-DD. A blank cell is
 * `null` (unknown) — never zero, never guessed.
 */

import { parseAccountingAmount } from '@/lib/import/spreadsheet';

export type Parsed<T> = { ok: true; value: T | null } | { ok: false; error: string };

const blank = (raw: string | null | undefined): boolean => raw == null || raw.trim() === '' || /^(n\/a|na|none|null|-|—|–)$/i.test(raw.trim());

/**
 * Money → integer cents. Accepts "$1,234.56", "1234.5", "(1,234.56)", "-12.30",
 * "1,234.56 CR", Excel floats ("12345.670000000002"). Negatives only when allowed.
 */
export function parseMoneyCell(raw: string | null | undefined, opts: { allowNegative?: boolean } = {}): Parsed<number> {
  if (blank(raw)) return { ok: true, value: null };
  const s = String(raw).trim();
  if (!/\d/.test(s)) return { ok: false, error: `“${s}” is not an amount` };
  const r = parseAccountingAmount(s);
  if (!r.ok) return { ok: false, error: `“${s}” is not an amount` };
  if (r.cents < 0 && !opts.allowNegative) return { ok: false, error: `“${s}” is negative — this amount can’t be negative` };
  return { ok: true, value: r.cents };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Two-digit years: 00–69 → 2000s, 70–99 → 1900s. */
function fullYear(y: string): number {
  const n = Number(y);
  if (y.length === 4) return n;
  return n <= 69 ? 2000 + n : 1900 + n;
}

/**
 * Date → ISO. Accepts (explicitly, nothing else):
 *   2026-01-05 · 2026-01-05T00:00:00Z · 1/5/2026 · 01/05/26 · 1-5-2026 (US month first)
 *   Jan 5, 2026 · 5-Jan-2026 · 05-JAN-26 · an Excel serial day number (e.g. 46027).
 */
export function parseDateCell(raw: string | null | undefined): Parsed<string> {
  if (blank(raw)) return { ok: true, value: null };
  const s = String(raw).trim();
  const bad = { ok: false as const, error: `“${s}” is not a date (use YYYY-MM-DD or M/D/YYYY)` };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) {
    const v = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return v ? { ok: true, value: v } : bad;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const v = iso(fullYear(m[3]), Number(m[1]), Number(m[2]));
    return v ? { ok: true, value: v } : bad;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()];
    const v = mo ? iso(Number(m[3]), mo, Number(m[2])) : null;
    return v ? { ok: true, value: v } : bad;
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const v = mo ? iso(fullYear(m[3]), mo, Number(m[1])) : null;
    return v ? { ok: true, value: v } : bad;
  }
  // Excel serial date (days since 1899-12-30), only in a plausible range (1954–2119).
  if (/^\d{5}(\.0+)?$/.test(s)) {
    const n = Math.trunc(Number(s));
    if (n >= 20000 && n <= 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
      return { ok: true, value: dt.toISOString().slice(0, 10) };
    }
  }
  return bad;
}

/** Whole number ("12", "1,200"). */
export function parseIntCell(raw: string | null | undefined, opts: { min?: number; max?: number } = {}): Parsed<number> {
  if (blank(raw)) return { ok: true, value: null };
  const s = String(raw).trim().replace(/,/g, '');
  if (!/^-?\d+(\.0+)?$/.test(s)) return { ok: false, error: `“${String(raw).trim()}” is not a whole number` };
  const n = Math.trunc(Number(s));
  if (!Number.isSafeInteger(n)) return { ok: false, error: `“${String(raw).trim()}” is too large` };
  if (opts.min !== undefined && n < opts.min) return { ok: false, error: `${n} is below ${opts.min}` };
  if (opts.max !== undefined && n > opts.max) return { ok: false, error: `${n} is above ${opts.max}` };
  return { ok: true, value: n };
}

/** Labor hours to hundredths → canonical string "1.50" (the API accepts the string, no float). */
export function parseHoursCell(raw: string | null | undefined): Parsed<string> {
  if (blank(raw)) return { ok: true, value: null };
  const s = String(raw).trim().replace(/\s*(hrs?|hours?)$/i, '');
  const m = /^(\d{1,5})(?:\.(\d*))?$/.exec(s);
  if (!m) return { ok: false, error: `“${String(raw).trim()}” is not a number of hours` };
  const frac = (m[2] ?? '').padEnd(3, '0');
  let hundredths = Number(m[1]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) hundredths += 1;
  return { ok: true, value: `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}` };
}

/**
 * A percentage → basis points ("25%" / "25" / "2.5" → 2500 / 2500 / 250). The column
 * label says "%", so a bare number is read as a percent. String math, no float drift.
 */
export function parsePctCell(raw: string | null | undefined): Parsed<number> {
  if (blank(raw)) return { ok: true, value: null };
  const s = String(raw).trim().replace(/%$/, '').trim();
  const m = /^(\d{1,4})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return { ok: false, error: `“${String(raw).trim()}” is not a percentage` };
  return { ok: true, value: Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) };
}

/** yes/no. */
export function parseBoolCell(raw: string | null | undefined): Parsed<boolean> {
  if (blank(raw)) return { ok: true, value: null };
  const s = String(raw).trim().toLowerCase();
  if (['y', 'yes', 'true', 't', '1', 'x'].includes(s)) return { ok: true, value: true };
  if (['n', 'no', 'false', 'f', '0'].includes(s)) return { ok: true, value: false };
  return { ok: false, error: `“${String(raw).trim()}” is not yes/no` };
}

/** Free text, trimmed, length-capped. */
export function parseTextCell(raw: string | null | undefined, max = 500): Parsed<string> {
  if (blank(raw)) return { ok: true, value: null };
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (s.length > max) return { ok: false, error: `Text is longer than ${max} characters` };
  return { ok: true, value: s };
}

/** Cents → canonical editable dollars "1234.56" (no float math). */
export function centsToCell(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Normalize a serial / reference / name for matching ("ab-12 34" → "AB1234"). */
export function normKey(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}
