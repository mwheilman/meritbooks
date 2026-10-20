/**
 * Minimal, dependency-free 5-field cron evaluator for the scheduler (M-12).
 *
 *   ┌ minute (0-59)  ┌ hour (0-23)  ┌ day-of-month (1-31)  ┌ month (1-12)  ┌ day-of-week (0-6, Sun=0; 7 also = Sun)
 *   *                *              *                      *               *
 *
 * Supports `*`, numbers, lists (`1,15`), ranges (`1-5`), and steps (`*\/15`, `0-30/10`).
 * All evaluation is in **UTC** (Vercel Cron is UTC too). Standard cron semantics for
 * day matching: when BOTH day-of-month and day-of-week are restricted, a day matches
 * if EITHER matches; otherwise the restricted one must match.
 *
 * PURE — no I/O, exhaustively unit-tested in cron.test.ts.
 */

export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export class CronParseError extends Error {
  constructor(expr: string, detail: string) {
    super(`Invalid cron "${expr}": ${detail}`);
    this.name = 'CronParseError';
  }
}

function parseField(expr: string, raw: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    if (part === '') throw new CronParseError(expr, `empty list item in ${label}`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronParseError(expr, `bad step in ${label}`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new CronParseError(expr, `bad step in ${label}`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+-\d+$/.test(rangePart)) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a;
      hi = b;
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart);
      hi = stepPart !== undefined ? max : lo;
    } else {
      throw new CronParseError(expr, `unsupported token "${part}" in ${label}`);
    }
    if (lo < min || hi > max || lo > hi) throw new CronParseError(expr, `${label} out of range (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression. Throws CronParseError on anything unsupported. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronParseError(expr, 'expected 5 fields (min hour dom mon dow)');
  const [mi, h, dom, mon, dow] = fields;
  const daysOfWeek = parseField(expr, dow, 0, 7, 'day-of-week');
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseField(expr, mi, 0, 59, 'minute'),
    hours: parseField(expr, h, 0, 23, 'hour'),
    daysOfMonth: parseField(expr, dom, 1, 31, 'day-of-month'),
    months: parseField(expr, mon, 1, 12, 'month'),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** True when the expression parses. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.months.has(d.getUTCMonth() + 1)) return false;
  const domOk = spec.daysOfMonth.has(d.getUTCDate());
  const dowOk = spec.daysOfWeek.has(d.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

const sortedDesc = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => b - a);
const sortedAsc = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);

/** How far back/forward we search before concluding the spec never fires (e.g. Feb 30). */
const SEARCH_DAYS = 366 * 5;

/**
 * The most recent occurrence at or before `at` (minute precision, UTC), or null if
 * the spec never fires within the search window (e.g. `0 0 30 2 *`).
 */
export function latestSlotAtOrBefore(spec: CronSpec, at: Date): Date | null {
  const hoursDesc = sortedDesc(spec.hours);
  const minutesDesc = sortedDesc(spec.minutes);
  const atMinute = Math.floor(at.getTime() / 60_000) * 60_000;
  const day = new Date(atMinute);
  day.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    if (dayMatches(spec, day)) {
      for (const h of hoursDesc) {
        for (const m of minutesDesc) {
          const t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
          if (t <= atMinute) return new Date(t);
        }
      }
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return null;
}

/** The first occurrence strictly after `at` (minute precision, UTC), or null. */
export function nextSlotAfter(spec: CronSpec, at: Date): Date | null {
  const hoursAsc = sortedAsc(spec.hours);
  const minutesAsc = sortedAsc(spec.minutes);
  const atMinute = Math.floor(at.getTime() / 60_000) * 60_000;
  const day = new Date(atMinute);
  day.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    if (dayMatches(spec, day)) {
      for (const h of hoursAsc) {
        for (const m of minutesAsc) {
          const t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
          if (t > atMinute) return new Date(t);
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return null;
}
