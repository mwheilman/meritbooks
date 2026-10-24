/**
 * Calendar-month helpers for number governance. PURE — no I/O, no Date-of-today reads
 * (callers pass `today`), all arithmetic in UTC so a server's timezone never shifts a month.
 */

import type { CloseStatus, PeriodKey } from './types';

const KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isPeriodKey(v: unknown): v is PeriodKey {
  return typeof v === 'string' && KEY_RE.test(v);
}

export function periodKey(year: number, month: number): PeriodKey {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function parsePeriodKey(key: PeriodKey): { year: number; month: number } {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Invalid period key '${key}' (expected YYYY-MM)`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** The month an ISO date ('YYYY-MM-DD…') falls in. */
export function monthOf(isoDate: string): PeriodKey {
  return isoDate.slice(0, 7);
}

export function addMonths(key: PeriodKey, n: number): PeriodKey {
  const { year, month } = parsePeriodKey(key);
  const idx = year * 12 + (month - 1) + n;
  return periodKey(Math.floor(idx / 12), (idx % 12) + 1);
}

/** Inclusive ascending range of months. Empty when from > to. Capped at 240 months. */
export function monthRange(from: PeriodKey, to: PeriodKey): PeriodKey[] {
  const out: PeriodKey[] = [];
  let k = from;
  while (k <= to && out.length < 240) {
    out.push(k);
    k = addMonths(k, 1);
  }
  return out;
}

/** Last day of the month, ISO. */
export function monthEnd(key: PeriodKey): string {
  const { year, month } = parsePeriodKey(key);
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b − a), both ISO dates. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** "Aug 2026". */
export function monthLabel(key: PeriodKey): string {
  const { year, month } = parsePeriodKey(key);
  return `${MONTHS[month - 1]} ${year}`;
}

/** "Oct 3, 2026". */
export function dateLabel(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Plain-English list: "Jun 2026", "Jun and Jul 2026" style is overkill — "Jun 2026, Jul 2026". */
export function monthList(keys: PeriodKey[]): string {
  const labels = keys.map(monthLabel);
  if (labels.length <= 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

const STATUS_RANK: Record<CloseStatus, number> = { NO_PERIOD: 0, OPEN: 1, SOFT_CLOSE: 2, HARD_CLOSE: 3 };

export function statusRank(s: CloseStatus): number {
  return STATUS_RANK[s];
}

/** The less-closed of two statuses. */
export function worstStatus(a: CloseStatus, b: CloseStatus): CloseStatus {
  return STATUS_RANK[a] <= STATUS_RANK[b] ? a : b;
}

export function minKey(keys: Array<PeriodKey | null>): PeriodKey | null {
  let out: PeriodKey | null = null;
  for (const k of keys) {
    if (k === null) return null;
    if (out === null || k < out) out = k;
  }
  return out;
}
