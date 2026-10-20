/**
 * Org-timezone calendar dates — PURE, framework-free, safe to import from client
 * components (no Supabase, no Next).
 *
 * WHY: `new Date().toISOString().slice(0, 10)` is the UTC calendar date. For a US
 * tenant after ~6–7pm local time that is already TOMORROW, so "as of today"
 * report defaults, overdue flags, and days-late counts ran a day ahead (audit
 * L14). Every "today"/as-of default must be the calendar date in the ORG's
 * timezone (`core.organizations.timezone`, default 'America/Chicago' per
 * migration 001), computed once and passed down as an ISO `YYYY-MM-DD` string.
 *
 * All date math here is on ISO date strings interpreted as UTC midnights, so it
 * is deterministic regardless of the server's or browser's local timezone.
 */

/** Matches the column default on core.organizations.timezone (migration 001). */
export const DEFAULT_ORG_TIMEZONE = 'America/Chicago';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** True when `tz` is an IANA zone this runtime can format with. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Normalize a stored timezone, falling back to the platform default. */
export function normalizeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_ORG_TIMEZONE;
}

/**
 * The calendar date (`YYYY-MM-DD`) at instant `now` in timezone `tz`.
 * `en-CA` formats as ISO year-month-day.
 */
export function todayInTimeZone(tz: string | null | undefined, now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimeZone(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA → "2026-10-19". Assemble from parts to be robust to locale-data quirks.
  const parts = fmt.formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isIsoDate(s: string | null | undefined): s is string {
  return typeof s === 'string' && ISO_DATE.test(s);
}

function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** `iso` shifted by `n` calendar days. */
export function addDaysIso(iso: string, n: number): string {
  return utcMsToIso(isoToUtcMs(iso) + n * DAY_MS);
}

/** Whole calendar days from `earlier` to `later` (negative when later < earlier). */
export function daysBetweenIso(later: string, earlier: string): number {
  return Math.round((isoToUtcMs(later) - isoToUtcMs(earlier)) / DAY_MS);
}

/** Last day of the given month (1-12). */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** First and last ISO dates of the month containing `iso`. */
export function monthBoundsIso(iso: string): { start: string; end: string } {
  const [y, m] = iso.split('-').map(Number);
  const p = (n: number) => String(n).padStart(2, '0');
  return { start: `${y}-${p(m)}-01`, end: `${y}-${p(m)}-${p(lastDayOfMonth(y, m))}` };
}

/** Clamp a fiscal-year start month into 1..12 (default January). */
export function normalizeFyStartMonth(m: number | null | undefined): number {
  const n = Math.trunc(Number(m));
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : 1;
}

/**
 * First day of the fiscal year that contains `asOf`, for a fiscal year that
 * starts on the 1st of `fyStartMonth` (1 = January). E.g. FY start July:
 * asOf 2026-10-19 → 2026-07-01; asOf 2026-05-11 → 2025-07-01.
 */
export function fiscalYearStartFor(asOf: string, fyStartMonth: number | null | undefined): string {
  const fm = normalizeFyStartMonth(fyStartMonth);
  const [y, m] = asOf.split('-').map(Number);
  const startYear = m >= fm ? y : y - 1;
  return `${startYear}-${String(fm).padStart(2, '0')}-01`;
}

/**
 * Long-form date label ("October 19, 2026") for an ISO date — timezone-free
 * (formats the calendar date itself, never an instant), so server and client
 * render byte-identical text.
 */
export function formatIsoDateLong(iso: string): string {
  return new Date(isoToUtcMs(iso)).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
