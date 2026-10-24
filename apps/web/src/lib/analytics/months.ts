/**
 * Month arithmetic for the metric registry and the analytics library.
 *
 * A reporting month is a `MonthKey` string 'YYYY-MM'. Everything here is pure and
 * calendar-exact (UTC, no time zones): a month's day count comes from the calendar,
 * fiscal years are anchored on a configurable start month (1 = January).
 */

export type MonthKey = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): value is MonthKey {
  return MONTH_RE.test(value);
}

function parse(m: MonthKey): { year: number; month: number } {
  const match = MONTH_RE.exec(m);
  if (!match) throw new Error(`Invalid month key "${m}" (expected YYYY-MM)`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** Absolute month index (year × 12 + month − 1) — handy for differences. */
export function monthIndex(m: MonthKey): number {
  const { year, month } = parse(m);
  return year * 12 + (month - 1);
}

export function fromMonthIndex(index: number): MonthKey {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function addMonths(m: MonthKey, n: number): MonthKey {
  return fromMonthIndex(monthIndex(m) + n);
}

/** b − a in months (positive when b is later). */
export function monthsBetween(a: MonthKey, b: MonthKey): number {
  return monthIndex(b) - monthIndex(a);
}

export function compareMonths(a: MonthKey, b: MonthKey): number {
  return monthIndex(a) - monthIndex(b);
}

/** Inclusive range from → to. Empty when to < from. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  const end = monthIndex(to);
  for (let i = monthIndex(from); i <= end; i++) out.push(fromMonthIndex(i));
  return out;
}

/** The `count` months ending at (and including) `end`, oldest first. */
export function trailingMonths(end: MonthKey, count: number): MonthKey[] {
  if (count <= 0) return [];
  return monthRange(addMonths(end, -(count - 1)), end);
}

export function calendarMonth(m: MonthKey): number {
  return parse(m).month;
}

export function calendarYear(m: MonthKey): number {
  return parse(m).year;
}

export function daysInMonth(m: MonthKey): number {
  const { year, month } = parse(m);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function daysInMonths(months: readonly MonthKey[]): number {
  return months.reduce((sum, m) => sum + daysInMonth(m), 0);
}

/** ISO date of the last day of the month. */
export function monthEndIso(m: MonthKey): string {
  return `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;
}

export function monthStartIso(m: MonthKey): string {
  return `${m}-01`;
}

/** Month key of an ISO date (yyyy-mm-dd…). */
export function monthOfIso(iso: string): MonthKey {
  const m = iso.slice(0, 7);
  if (!isMonthKey(m)) throw new Error(`Invalid ISO date "${iso}"`);
  return m;
}

function assertFyStart(fyStartMonth: number): void {
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12) {
    throw new Error(`Fiscal-year start month must be 1..12, got ${fyStartMonth}`);
  }
}

/** First month of the fiscal year that contains `m`. */
export function fiscalYearStart(m: MonthKey, fyStartMonth = 1): MonthKey {
  assertFyStart(fyStartMonth);
  const { year, month } = parse(m);
  const startYear = month >= fyStartMonth ? year : year - 1;
  return `${String(startYear).padStart(4, '0')}-${String(fyStartMonth).padStart(2, '0')}`;
}

/**
 * Fiscal year label: the calendar year in which the fiscal year ENDS
 * (FY starting Jul 2025 → FY 2026). Calendar-year tenants get the calendar year.
 */
export function fiscalYearOf(m: MonthKey, fyStartMonth = 1): number {
  const start = fiscalYearStart(m, fyStartMonth);
  return calendarYear(addMonths(start, 11));
}

/** Fiscal period number 1..12 of `m`. */
export function fiscalPeriodOf(m: MonthKey, fyStartMonth = 1): number {
  return monthsBetween(fiscalYearStart(m, fyStartMonth), m) + 1;
}

/** First month of the fiscal quarter containing `m`. */
export function fiscalQuarterStart(m: MonthKey, fyStartMonth = 1): MonthKey {
  const fyStart = fiscalYearStart(m, fyStartMonth);
  const offset = monthsBetween(fyStart, m);
  return addMonths(fyStart, Math.floor(offset / 3) * 3);
}

/** Short human label: "Aug ’26". */
export function shortMonthLabel(m: MonthKey): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const { year, month } = parse(m);
  return `${names[month - 1]} ’${String(year % 100).padStart(2, '0')}`;
}
