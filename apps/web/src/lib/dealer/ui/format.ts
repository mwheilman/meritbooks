/**
 * Dealer Pack (D2) — display + input helpers. Pure and client-safe.
 * Money stays integer cents end to end (CANON §2); only the edge formats it.
 */

import { formatMoney } from '@meritbooks/shared';

/** Cents → "$1,234.56" (negative → "-$1,234.56"); null → em dash. */
export function money(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined || cents === '') return '—';
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  return formatMoney(n);
}

/** Compact money for tiles: $1.2M / $34.5K / $980. */
export function moneyCompact(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return formatMoney(cents);
}

/** Basis points → "9.00%". */
export function bpsToPct(bps: number | null | undefined, digits = 2): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  return `${(bps / 100).toFixed(digits)}%`;
}

/** "9.5" / "9.50%" → 950 bps; null when not a number. */
export function pctToBps(input: string): number | null {
  const s = input.replace(/%/g, '').trim();
  if (s === '' || !/^-?\d+(\.\d{1,4})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/**
 * Parse a dollars string a person typed ("1,234.5", "$1234.50", "1234") → integer
 * cents, without floating-point drift. Returns null for anything that isn't money.
 */
export function parseDollarsToCents(input: string, opts: { allowNegative?: boolean } = {}): number | null {
  const s = input.replace(/[$,\s]/g, '');
  if (s === '') return null;
  const m = /^(-)?(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  if (m[1] && !opts.allowNegative) return null;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole)) return null;
  const cents = whole * 100 + frac;
  return m[1] ? -cents : cents;
}

/** Cents → editable dollars string ("1234.50"); null → "". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-20" → "Oct 20, 2026"; null → em dash. Parses the ISO date without TZ drift. */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** Day number (UTC) for an ISO date. */
function dayN(iso: string): number {
  const [y, mo, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000);
}

/** Whole days from `from` to `to` (to − from). Null when either is missing. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  return dayN(to) - dayN(from);
}

/** Today in local time as YYYY-MM-DD (what a person means by "today"). */
export function todayLocal(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Last day of the month before `iso` (month-end accrual default). */
export function lastDayOfPriorMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 0));
  return d.toISOString().slice(0, 10);
}

/** First and last day of the month containing `iso`. */
export function monthRange(iso: string): { start: string; end: string } {
  const [y, m] = iso.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** "12 days" / "1 day" / "—". */
export function daysLabel(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toLocaleString()} ${Math.abs(n) === 1 ? 'day' : 'days'}`;
}

/** "in 5 days" / "5 days ago" / "today" for a due date relative to today. */
export function relativeDue(iso: string | null | undefined, today: string): string {
  const d = daysBetween(today, iso);
  if (d === null) return '—';
  if (d === 0) return 'today';
  if (d > 0) return `in ${daysLabel(d)}`;
  return `${daysLabel(-d)} ago`;
}

/** Labor hours shown with two decimals. */
export function hours(h: number | string | null | undefined): string {
  if (h === null || h === undefined || h === '') return '—';
  const n = Number(h);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}
