/**
 * Working-day math on ISO days, the same model as the SQL engine in migration 1112
 * (working days on the job calendar, pm.schedule_calendar).
 * All arithmetic is on UTC day numbers, so no time zone or DST can shift a date.
 */
import type { WorkCalendar } from './types';

const MS_DAY = 86_400_000;

/** Days since 1970-01-01 for "2026-11-16" (parsed by hand: this runs per task per drag frame). */
export function dayNum(iso: string): number {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const d = +iso.slice(8, 10);
  if (y && m && d) return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
  return Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / MS_DAY);
}

const ISO_CACHE = new Map<number, string>();

export function isoOf(n: number): string {
  let s = ISO_CACHE.get(n);
  if (s === undefined) {
    s = new Date(n * MS_DAY).toISOString().slice(0, 10);
    if (ISO_CACHE.size > 20_000) ISO_CACHE.clear();
    ISO_CACHE.set(n, s);
  }
  return s;
}

export function plusDays(iso: string, days: number): string {
  return isoOf(dayNum(iso) + days);
}

/** ISO weekday of a day number: 1 = Monday … 7 = Sunday (1970-01-01 was a Thursday). */
export function dowOf(n: number): number {
  return ((((n + 3) % 7) + 7) % 7) + 1;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoDow(iso: string): number {
  return dowOf(dayNum(iso));
}

/** Per calendar: working weekdays as a bitmask and exceptions by day number. */
const COMPILED = new WeakMap<WorkCalendar, { mask: number; ex: Map<number, boolean> }>();
function compiled(cal: WorkCalendar): { mask: number; ex: Map<number, boolean> } {
  let c = COMPILED.get(cal);
  if (!c) {
    let mask = 0;
    for (const d of cal.workdays) mask |= 1 << d;
    const ex = new Map<number, boolean>();
    for (const [day, w] of Object.entries(cal.exceptions)) ex.set(dayNum(day), w);
    c = { mask, ex };
    COMPILED.set(cal, c);
  }
  return c;
}

export function isWorkdayNum(cal: WorkCalendar, n: number): boolean {
  const c = compiled(cal);
  const ex = c.ex.get(n);
  if (ex !== undefined) return ex;
  return (c.mask & (1 << dowOf(n))) !== 0;
}

export function isWorkday(cal: WorkCalendar, iso: string): boolean {
  return isWorkdayNum(cal, dayNum(iso));
}

/** Working day numbers in [a, b], ascending. */
export function workdayNumsIn(cal: WorkCalendar, a: number, b: number): number[] {
  const out: number[] = [];
  for (let n = a; n <= b; n++) if (isWorkdayNum(cal, n)) out.push(n);
  return out;
}

/** Working days in [from, to], ascending. */
export function workdaysIn(cal: WorkCalendar, from: string, to: string): string[] {
  return workdayNumsIn(cal, dayNum(from), dayNum(to)).map(isoOf);
}

/** How many working days in [from, to] (no allocation). */
export function countWorkdays(cal: WorkCalendar, from: string, to: string): number {
  const a = dayNum(from);
  const b = dayNum(to);
  let k = 0;
  for (let n = a; n <= b; n++) if (isWorkdayNum(cal, n)) k++;
  return k;
}

/** Number of elements of the ascending list `w` that are < `iso` (binary search). */
export function countBefore(w: readonly string[], iso: string): number {
  let lo = 0;
  let hi = w.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((w[mid] as string) < iso) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The n-th working day after `iso` (n > 0), before it (n < 0), or the first working day on or after
 * it (n = 0). Working-day addition.
 */
export function addWorkdays(cal: WorkCalendar, iso: string, n: number): string {
  if (!cal.workdays.length && !Object.values(cal.exceptions).some(Boolean)) return iso;
  let d = dayNum(iso);
  if (n === 0) {
    for (let guard = 0; guard < 3700; guard++, d++) if (isWorkdayNum(cal, d)) return isoOf(d);
    return iso;
  }
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  for (let guard = 0; guard < 3700 * 3 && left > 0; guard++) {
    d += step;
    if (isWorkdayNum(cal, d)) left--;
  }
  return isoOf(d);
}

/** Signed working days in (a, b] when b > a; minus those in (b, a] when b < a. Signed working-day distance. */
export function workdaysBetween(cal: WorkCalendar, a: string, b: string): number {
  if (a === b) return 0;
  if (b > a) return countWorkdays(cal, plusDays(a, 1), b);
  return -countWorkdays(cal, plusDays(b, 1), a);
}

/** Working days in [start, finish] (a task's duration from its dates); at least 1 when finish ≥ start. */
export function workdaysInclusive(cal: WorkCalendar, start: string, finish: string): number {
  if (finish < start) return 0;
  return countWorkdays(cal, start, finish);
}

/**
 * The finish of a task of `duration` working days starting on `start` (inclusive), i.e. the
 * (duration − 1)-th working day after the first working day on or after start.
 */
export function finishFor(cal: WorkCalendar, start: string, duration: number): string {
  const s = addWorkdays(cal, start, 0);
  return duration <= 1 ? s : addWorkdays(cal, s, duration - 1);
}

/** Calendar from pm.work_calendars + pm.work_calendar_days rows. */
export function makeCalendar(
  row: { id: string | null; name: string; workdays: number[]; hours_per_day: number },
  days: ReadonlyArray<{ day: string; is_workday: boolean; name?: string | null }> = [],
): WorkCalendar {
  const exceptions: Record<string, boolean> = {};
  const names: Record<string, string> = {};
  for (const d of days) {
    exceptions[d.day] = d.is_workday;
    if (d.name) names[d.day] = d.name;
  }
  const workdays = [...new Set(row.workdays.map(Number).filter((x) => x >= 1 && x <= 7))].sort((x, y) => x - y);
  return { id: row.id, name: row.name, workdays, hours_per_day: Number(row.hours_per_day) || 8, exceptions, names };
}

/** Non-working days in [from, to] (weekends and holidays), for the timeline shading. */
export function offDaysIn(cal: WorkCalendar, from: string, to: string): Array<{ day: string; holiday: boolean; name: string | null }> {
  const out: Array<{ day: string; holiday: boolean; name: string | null }> = [];
  const a = dayNum(from);
  const b = dayNum(to);
  for (let n = a; n <= b; n++) {
    const iso = isoOf(n);
    if (isWorkday(cal, iso)) continue;
    out.push({ day: iso, holiday: cal.exceptions[iso] === false, name: cal.names?.[iso] ?? null });
  }
  return out;
}
