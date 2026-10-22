import { compactMoney, dayDate, money, shortDate } from '@meritbooks/merit-ui';
import type { PeriodStatus } from './actions';

/** Integer cents → "3,184.62" / "(4,454.42)" (kit format: tabular, negatives in parentheses). */
export function cents(n: number): string {
  return money(Math.round(n));
}

/** Integer cents → "1.2M" / "(48K)" for tight cells. */
export function centsCompact(n: number): string {
  return compactMoney(Math.round(n));
}

/** A calendar date (YYYY-MM-DD) read at noon so no timezone can move the day. */
function civil(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00`);
}

/** "Tue Oct 21". */
export function dayLabel(iso: string): string {
  return iso ? dayDate(civil(iso)) : '';
}

/** "Oct 21". */
export function shortLabel(iso: string): string {
  return iso ? shortDate(civil(iso)) : '';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "October". */
export function monthLabel(iso: string): string {
  return iso ? (MONTHS[Number(iso.slice(5, 7)) - 1] ?? '') : '';
}

export const PERIOD_WORD: Record<PeriodStatus, string> = {
  OPEN: 'open',
  SOFT_CLOSE: 'soft close',
  HARD_CLOSE: 'closed',
  NO_PERIOD: 'no period set up',
};

/** "3h ago" — relative age for activity rows. */
export function ago(isoTs: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(isoTs).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
