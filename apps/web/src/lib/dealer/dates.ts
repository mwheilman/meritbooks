/**
 * Calendar-date helpers for the dealer engines. Dates are ISO 'YYYY-MM-DD' strings
 * handled as whole UTC days — never local time — so interest day counts are exact.
 */

import { DealerEngineError } from './types';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Whole days since 1970-01-01 for an ISO date. Throws on a malformed date. */
export function dayNumber(iso: string): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new DealerEngineError(`Invalid date '${iso}' (expected YYYY-MM-DD)`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms).toISOString().slice(0, 10);
  if (back !== iso) throw new DealerEngineError(`Invalid calendar date '${iso}'`);
  return Math.round(ms / MS_PER_DAY);
}

export function fromDayNumber(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days);
}

/** b − a in whole days. */
export function diffDays(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

export function maxDate(a: string, b: string): string {
  return dayNumber(a) >= dayNumber(b) ? a : b;
}

export function minDate(a: string, b: string): string {
  return dayNumber(a) <= dayNumber(b) ? a : b;
}

/** First and last day of the month containing `iso`. */
export function monthBounds(iso: string): { start: string; end: string } {
  const [y, m] = iso.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
