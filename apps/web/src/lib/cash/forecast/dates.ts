/**
 * Calendar helpers for the cash forecast — pure, UTC, ISO 'yyyy-mm-dd' strings only.
 * No Date-in/Date-out ambiguity: every function takes and returns ISO day strings.
 */

const DAY_MS = 86_400_000;

export function parseIso(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) && !Number.isNaN(parseIso(s).getTime());
}

export function addDays(iso: string, n: number): string {
  return toIso(new Date(parseIso(iso).getTime() + n * DAY_MS));
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / DAY_MS);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Add calendar months, clamping the day to the target month's length (Jan 31 + 1 → Feb 28/29). */
export function addMonths(iso: string, n: number, day?: number): string {
  const d = parseIso(iso);
  const targetDay = day ?? d.getUTCDate();
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = daysInMonth(base.getUTCFullYear(), base.getUTCMonth() + 1);
  base.setUTCDate(Math.min(targetDay, last));
  return toIso(base);
}

export function endOfMonth(iso: string): string {
  const d = parseIso(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Monday on or before the date. */
export function mondayOf(iso: string): string {
  const d = parseIso(iso);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
}

export function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

export type PayFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';

/**
 * The next pay date after `from` for a frequency:
 *   WEEKLY +7d · BIWEEKLY +14d · SEMIMONTHLY → the 15th or the month end, whichever comes next ·
 *   MONTHLY → same day next month (clamped).
 */
export function nextPayDate(from: string, freq: PayFrequency, monthlyDay?: number): string {
  if (freq === 'WEEKLY') return addDays(from, 7);
  if (freq === 'BIWEEKLY') return addDays(from, 14);
  if (freq === 'MONTHLY') return addMonths(from, 1, monthlyDay);
  // SEMIMONTHLY: the 15th and the last day of each month.
  const d = parseIso(from);
  const day = d.getUTCDate();
  const eom = endOfMonth(from);
  if (day < 15) return `${from.slice(0, 7)}-15`;
  if (from < eom) return eom;
  return `${addMonths(startOfMonth(from), 1).slice(0, 7)}-15`;
}

/** Pay dates strictly after `last` up to and including `until`. Capped (no runaway loops). */
export function payDatesAfter(last: string, freq: PayFrequency, until: string, cap = 60): string[] {
  const out: string[] = [];
  const monthlyDay = freq === 'MONTHLY' ? parseIso(last).getUTCDate() : undefined;
  let d = nextPayDate(last, freq, monthlyDay);
  while (d <= until && out.length < cap) {
    out.push(d);
    d = nextPayDate(d, freq, monthlyDay);
  }
  return out;
}

export type RecurringFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

/**
 * One recurring-invoice cadence step (mirrors lib/invoices/recurring-invoices `advanceRecurringDate`,
 * kept here so the forecast engine stays free of that module's I/O imports).
 */
export function advanceRecurring(date: string, freq: RecurringFrequency, intervalCount = 1): string {
  const n = Math.max(1, Math.floor(intervalCount || 1));
  if (freq === 'WEEKLY') return addDays(date, 7 * n);
  if (freq === 'BIWEEKLY') return addDays(date, 14 * n);
  const months = freq === 'MONTHLY' ? 1 : freq === 'QUARTERLY' ? 3 : freq === 'SEMIANNUAL' ? 6 : 12;
  return addMonths(date, months * n);
}

export const MONTHS_PER: Readonly<Record<string, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
  ANNUALLY: 12,
};
