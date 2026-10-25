/**
 * Portal formatting (client-safe, pure): money from integer cents, dates, the $ impact sentence
 * of a queue item, and the Books pay link. Locale-aware (en-US / es-US).
 */
import { booksUrl } from '@/lib/books-url';
import type { Locale, QueueItem } from './types';
import { t } from './i18n';

const tag = (l: Locale): string => (l === 'es' ? 'es-US' : 'en-US');

/** $1,840.00 — integer cents only (never floats in, never rounding beyond cents). */
export function money(cents: number | null | undefined, l: Locale = 'en'): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toLocaleString(tag(l), { useGrouping: true, maximumFractionDigits: 0 });
  const s = `$${grouped}.${frac}`;
  return neg ? `(${s})` : s;
}

export function date(iso: string | null | undefined, l: Locale = 'en'): string {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(tag(l), { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dateTime(iso: string | null | undefined, l: Locale = 'en'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(tag(l), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Whole days from today to an ISO date (negative = past). */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** "Due in 3 days" / "Due today" / "4 days late" / "". */
export function deadlineText(iso: string | null | undefined, l: Locale, now: Date = new Date()): string {
  const n = daysUntil(iso, now);
  if (n === null) return '';
  if (n === 0) return t(l, 'due.today');
  if (n === 1) return t(l, 'due.tomorrow');
  if (n > 1) return t(l, 'due.in', { n });
  return t(l, 'due.late', { n: -n });
}

/** The $ impact sentence of a queue item ("Adds $1,840.00 over the allowance"). */
export function impactText(item: Pick<QueueItem, 'amount_cents' | 'amount_kind' | 'schedule_days'>, l: Locale): string {
  const c = item.amount_cents;
  if (c === null || c === undefined) return '';
  switch (item.amount_kind) {
    case 'vs_allowance':
      return c > 0 ? t(l, 'impact.over', { amount: money(c, l) }) : c < 0 ? t(l, 'impact.under', { amount: money(-c, l) }) : t(l, 'impact.at');
    case 'change': {
      const days = item.schedule_days ? ` ${t(l, item.schedule_days > 0 ? 'impact.days_more' : 'impact.days_less', { n: Math.abs(item.schedule_days) })}` : '';
      return (c >= 0 ? t(l, 'impact.adds', { amount: money(c, l) }) : t(l, 'impact.credits', { amount: money(-c, l) })) + days;
    }
    case 'balance':
      return t(l, 'impact.balance', { amount: money(c, l) });
    case 'requested':
      return t(l, 'impact.requested', { amount: money(c, l) });
    case 'waiver':
      return t(l, 'impact.waiver', { amount: money(c, l) });
    default:
      return t(l, 'impact.total', { amount: money(c, l) });
  }
}

/** Merit Books' hosted invoice / pay page for an invoice's public token (Books 050 / 176). */
export function booksPayUrl(token: string): string {
  return `${booksUrl()}/pay/${encodeURIComponent(token)}`;
}
