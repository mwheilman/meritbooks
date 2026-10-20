/**
 * Cell values → typed values. Money is integer CENTS parsed from the string (never
 * float math); dates are ISO yyyy-mm-dd; statuses collapse to five words. Pure.
 */
import type { ImportStatus } from '../types';

/**
 * "$12,500.00" → 1250000 · "12500" → 1250000 · "(1,200)" → -120000 · "-$45.10" → -4510 ·
 * "1,234.56 CR" → -123456 · "12345.670000000002" (Excel float) → 1234567 · "" → null.
 * Returns undefined for text that isn't money ("TBD").
 */
export function parseMoneyToCents(raw: string | number | null | undefined): number | null | undefined {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === '–') return null;
  let negative = false;
  s = s.replace(/^(USD|US\$|\$)\s*\(/i, '(');
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  const crdr = s.match(/\s*(CR|DR)\.?$/i);
  if (crdr) { if (crdr[1].toUpperCase() === 'CR') negative = !negative; s = s.slice(0, crdr.index).trim(); }
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1).trim(); }
  s = s.replace(/^(USD|US\$|\$)\s*/i, '').replace(/\s*USD$/i, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1).trim(); } else if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/^\$\s*/, '').replace(/[,\s]/g, '');
  if (s === '') return null;
  let cents: number;
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return undefined;
    cents = Math.round(Math.abs(n) * 100);
    if (n < 0) negative = !negative;
  } else {
    const m = s.match(/^(\d*)(?:\.(\d*))?$/);
    if (!m || (m[1] === '' && (m[2] ?? '') === '')) return undefined;
    const frac = (m[2] ?? '').padEnd(3, '0');
    let c = Number(frac.slice(0, 2));
    if (Number(frac[2]) >= 5) c += 1;
    cents = (m[1] === '' ? 0 : Number(m[1])) * 100 + c;
  }
  if (!Number.isSafeInteger(cents)) return undefined;
  return negative && cents !== 0 ? -cents : cents;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 2026-03-04 · 3/4/2026 · 03/04/26 · Mar 4, 2026 · 4-Mar-2026 · Excel serial 46085 → ISO date (US month-first). */
export function parseDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s.*)?$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return iso(y, +m[1], +m[2]);
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return iso(+m[3], mo, +m[2]);
  }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (mo) return iso(y, mo, +m[1]);
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial > 18000 && serial < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
  }
  return null;
}

const STATUS_WORDS: [ImportStatus, RegExp][] = [
  ['cancelled', /\b(cancel+ed|cancel|void|lost|dead|declined|rejected|abandoned)\b/],
  ['complete', /\b(complete|completed|closed|finished|done|invoiced|paid|warranty|archived)\b/],
  ['on_hold', /\b(hold|on hold|paused|suspended|waiting)\b/],
  ['bid', /\b(bid|bidding|estimate|estimating|lead|quote|quoted|proposal|pending|presale|pre sale|prospect|opportunity|draft)\b/],
  ['active', /\b(active|open|in progress|progress|wip|scheduled|started|sold|approved|underway|under construction|production|signed|contracted|ready)\b/],
];

/** Free-text status → one of five words (null when it says nothing we recognize). */
export function normalizeStatus(raw: string | null | undefined): ImportStatus | null {
  const s = (raw ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!s) return null;
  for (const [status, re] of STATUS_WORDS) if (re.test(s)) return status;
  return null;
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(llc|inc|co|corp|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
