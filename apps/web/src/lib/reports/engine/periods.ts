/**
 * Period engine (pure). Fiscal-year aware month / quarter / year / to-date / TTM / custom
 * ranges, comparison windows and column buckets. All dates are ISO 'YYYY-MM-DD' strings
 * handled in UTC arithmetic — never `new Date()` of a local date (no timezone drift).
 */
import type { DateRange, PeriodSpec } from './types';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIso(s: string | null | undefined): s is string {
  return typeof s === 'string' && ISO_RE.test(s);
}

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
}

function fmt(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthStart(iso: string): string {
  const [y, m] = parts(iso);
  return fmt(y, m, 1);
}

export function monthEnd(iso: string): string {
  const [y, m] = parts(iso);
  return fmt(y, m, daysInMonth(y, m));
}

/** Shift a date by n months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = parts(iso);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = parts(iso);
  return fmt(y, m, d + n);
}

export function isMonthStart(iso: string): boolean {
  return iso.endsWith('-01');
}

export function isMonthEnd(iso: string): boolean {
  return monthEnd(iso) === iso;
}

/** A range is month-aligned when it starts on a 1st (or from inception) and ends on a month end. */
export function isMonthAligned(r: DateRange): boolean {
  return (r.start === null || isMonthStart(r.start)) && isMonthEnd(r.end);
}

export function rangeKey(r: DateRange): string {
  return `${r.start ?? '*'}..${r.end}`;
}

export function normalizeFyStart(m: number | null | undefined): number {
  const n = Number(m);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}

/** First day of the fiscal year containing `iso`. */
export function fiscalYearStart(iso: string, fyStartMonth: number): string {
  const fy = normalizeFyStart(fyStartMonth);
  const [y, m] = parts(iso);
  const startYear = m >= fy ? y : y - 1;
  return fmt(startYear, fy, 1);
}

/** Fiscal year label: the calendar year in which the fiscal year ENDS (FY2026 = Jul 2025–Jun 2026). */
export function fiscalYearLabel(iso: string, fyStartMonth: number): string {
  const start = fiscalYearStart(iso, fyStartMonth);
  const end = addDays(addMonths(start, 12), -1);
  return normalizeFyStart(fyStartMonth) === 1 ? start.slice(0, 4) : `FY${end.slice(0, 4)}`;
}

/** First day of the fiscal quarter containing `iso`. */
export function fiscalQuarterStart(iso: string, fyStartMonth: number): string {
  const fyStart = fiscalYearStart(iso, fyStartMonth);
  const months = monthsBetween(fyStart, monthStart(iso));
  return addMonths(fyStart, Math.floor(months / 3) * 3);
}

/** Whole months from a's month to b's month (b ≥ a → ≥ 0). */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = parts(a);
  const [by, bm] = parts(b);
  return (by * 12 + bm) - (ay * 12 + am);
}

/** Resolve a period spec into a concrete range (fiscal-year aware). */
export function resolvePeriod(spec: PeriodSpec, fyStartMonth: number): DateRange {
  const asOf = isIso(spec.asOf) ? spec.asOf : new Date().toISOString().slice(0, 10);
  switch (spec.preset) {
    case 'month':
      return { start: monthStart(asOf), end: monthEnd(asOf) };
    case 'quarter': {
      const qs = fiscalQuarterStart(asOf, fyStartMonth);
      return { start: qs, end: addDays(addMonths(qs, 3), -1) };
    }
    case 'year': {
      const ys = fiscalYearStart(asOf, fyStartMonth);
      return { start: ys, end: addDays(addMonths(ys, 12), -1) };
    }
    case 'mtd':
      return { start: monthStart(asOf), end: asOf };
    case 'qtd':
      return { start: fiscalQuarterStart(asOf, fyStartMonth), end: asOf };
    case 'ytd':
      return { start: fiscalYearStart(asOf, fyStartMonth), end: asOf };
    case 'ttm':
      return { start: addMonths(monthStart(asOf), -11), end: monthEnd(asOf) };
    case 'custom': {
      const start = isIso(spec.start) ? spec.start : monthStart(asOf);
      const end = isIso(spec.end) ? spec.end : asOf;
      return start <= end ? { start, end } : { start: end, end: start };
    }
  }
}

/**
 * The immediately preceding window of EQUAL LENGTH. Month-aligned ranges shift by whole
 * months (Q2 → Q1, Mar → Feb); day ranges shift by their day count.
 */
export function priorPeriod(r: DateRange): DateRange {
  if (r.start === null) return { start: null, end: addDays(r.end, -1) };
  if (isMonthStart(r.start) && isMonthEnd(r.end)) {
    const n = monthsBetween(r.start, r.end) + 1;
    const start = addMonths(r.start, -n);
    return { start, end: addDays(r.start, -1) };
  }
  if (isMonthStart(r.start) && monthStart(r.start) === monthStart(r.end)) {
    // MTD-style: same day count of the previous month (clamped)
    const start = addMonths(r.start, -1);
    const end = addMonths(r.end, -1);
    return { start, end };
  }
  const days = dayDiff(r.start, r.end) + 1;
  return { start: addDays(r.start, -days), end: addDays(r.start, -1) };
}

/** The same window one year earlier (month ends stay month ends: Feb 29 → Feb 28). */
export function priorYear(r: DateRange): DateRange {
  const end = isMonthEnd(r.end) ? monthEnd(addMonths(monthStart(r.end), -12)) : addMonths(r.end, -12);
  return { start: r.start === null ? null : addMonths(r.start, -12), end };
}

export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Month starts ('YYYY-MM-01') covered by a range (partial months included). */
export function monthsIn(r: { start: string; end: string }): string[] {
  const out: string[] = [];
  let cur = monthStart(r.start);
  const last = monthStart(r.end);
  while (cur <= last) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

export interface Bucket {
  id: string;
  label: string;
  sublabel?: string;
  range: { start: string; end: string };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(iso: string): string {
  const [y, m] = parts(iso);
  return `${MONTH_ABBR[m - 1]} ${y}`;
}

export function rangeLabel(r: DateRange): string {
  if (r.start === null) return `As of ${longDate(r.end)}`;
  if (isMonthStart(r.start) && isMonthEnd(r.end) && monthStart(r.start) === monthStart(r.end)) return monthLabel(r.start);
  if (isMonthStart(r.start) && isMonthEnd(r.end)) return `${monthLabel(r.start)} – ${monthLabel(r.end)}`;
  return `${shortDate(r.start)} – ${shortDate(r.end)}`;
}

export function shortDate(iso: string): string {
  const [y, m, d] = parts(iso);
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

export function longDate(iso: string): string {
  const [y, m, d] = parts(iso);
  const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${FULL[m - 1]} ${d}, ${y}`;
}

/**
 * Column buckets for month / quarter / year columns. When the selected range spans more
 * than one bucket, the buckets are those inside it; otherwise `count` trailing buckets
 * ending with the range's bucket (a single month → the trailing 12 months).
 * The last bucket ends on the range end (so a YTD-to-the-24th month is exact).
 */
export function buckets(
  mode: 'month' | 'quarter' | 'year',
  r: { start: string; end: string },
  fyStartMonth: number,
  count?: number,
): Bucket[] {
  const step = mode === 'month' ? 1 : mode === 'quarter' ? 3 : 12;
  const bucketStart = (iso: string) =>
    mode === 'month' ? monthStart(iso) : mode === 'quarter' ? fiscalQuarterStart(iso, fyStartMonth) : fiscalYearStart(iso, fyStartMonth);
  const firstOfRange = bucketStart(r.start);
  const lastOfRange = bucketStart(r.end);
  let starts: string[] = [];
  if (firstOfRange !== lastOfRange) {
    let cur = firstOfRange;
    while (cur <= lastOfRange) {
      starts.push(cur);
      cur = addMonths(cur, step);
    }
  } else {
    const n = Math.max(1, Math.min(count ?? (mode === 'month' ? 12 : mode === 'quarter' ? 4 : 3), 60));
    for (let i = n - 1; i >= 0; i--) starts.push(addMonths(lastOfRange, -i * step));
  }
  starts = starts.slice(-60);
  return starts.map((s, i) => {
    const naturalEnd = addDays(addMonths(s, step), -1);
    const isLast = i === starts.length - 1;
    const end = isLast && r.end < naturalEnd ? r.end : naturalEnd;
    const start = i === 0 && r.start > s && firstOfRange !== lastOfRange ? r.start : s;
    let label: string;
    if (mode === 'month') label = monthLabel(s);
    else if (mode === 'quarter') {
      const fyS = fiscalYearStart(s, fyStartMonth);
      const q = Math.floor(monthsBetween(fyS, s) / 3) + 1;
      label = `Q${q} ${fiscalYearLabel(s, fyStartMonth)}`;
    } else label = fiscalYearLabel(s, fyStartMonth);
    return { id: `${mode}:${s}`, label, range: { start, end }, sublabel: end < naturalEnd ? `to ${shortDate(end)}` : undefined };
  });
}
