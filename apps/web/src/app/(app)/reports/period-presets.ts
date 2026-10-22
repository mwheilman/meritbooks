/**
 * Report period presets, computed from an explicit "today" (YYYY-MM-DD) instead of
 * `new Date()` during render.
 *
 * Hydration fix (live smoke test, React #418/#423 on full loads of /reports): the
 * viewer used to evaluate `new Date()` while rendering, so the server (UTC) and the
 * browser (the user's zone) could disagree on the date — every evening in the US the
 * UTC "today" is already tomorrow. The page now passes the server's date in, the first
 * client render uses that same string, and the browser's own date replaces it after
 * mount (an ordinary state update, never a hydration mismatch). Pure; no timezone math
 * beyond reading the parts of the given date.
 */

export type PeriodKey =
  | 'this_month' | 'last_month' | 'this_qtr' | 'last_qtr' | 'ytd' | 'ytd_closed' | 'last_year' | 'last_12' | 'custom';

export const PERIOD_OPTIONS: ReadonlyArray<{ key: PeriodKey; label: string }> = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_qtr', label: 'This Quarter' },
  { key: 'last_qtr', label: 'Last Quarter' },
  { key: 'ytd', label: 'Year to Date' },
  { key: 'ytd_closed', label: 'YTD Through Last Month' },
  { key: 'last_year', label: 'Last Year' },
  { key: 'last_12', label: 'Last 12 Months' },
  { key: 'custom', label: 'Custom Range' },
];

export function isPeriodKey(v: unknown): v is PeriodKey {
  return typeof v === 'string' && PERIOD_OPTIONS.some((p) => p.key === v);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** A calendar date (y, m 1-12, d) → 'YYYY-MM-DD'; overflow / underflow rolls like Date. */
function ymd(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Last day of month m (1-12) of year y. */
function monthEnd(y: number, m: number): string {
  return ymd(y, m + 1, 0);
}

/** 'YYYY-MM-DD' of a Date in the zone it's read in (the browser's local date). */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' of a Date in UTC (the server's seed). */
export function utcIsoDate(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The start / end of a preset relative to `today` ('YYYY-MM-DD'). Custom → empty. */
export function periodRange(key: PeriodKey, today: string): { s: string; e: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m || key === 'custom') return { s: '', e: '' };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const q = Math.floor((mo - 1) / 3) * 3 + 1; // first month of this quarter
  switch (key) {
    case 'this_month':
      return { s: ymd(y, mo, 1), e: monthEnd(y, mo) };
    case 'last_month':
      return { s: ymd(y, mo - 1, 1), e: monthEnd(y, mo - 1) };
    case 'this_qtr':
      return { s: ymd(y, q, 1), e: monthEnd(y, q + 2) };
    case 'last_qtr':
      return { s: ymd(y, q - 3, 1), e: monthEnd(y, q - 1) };
    case 'ytd':
      return { s: `${y}-01-01`, e: today };
    case 'ytd_closed':
      return { s: `${y}-01-01`, e: ymd(y, mo, 0) };
    case 'last_year':
      return { s: `${y - 1}-01-01`, e: `${y - 1}-12-31` };
    case 'last_12':
      return { s: ymd(y - 1, mo, d + 1), e: today };
    default:
      return { s: '', e: '' };
  }
}
