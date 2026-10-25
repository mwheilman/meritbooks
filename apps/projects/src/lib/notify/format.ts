/**
 * Inbox presentation helpers (bell + /inbox). Pure and client-safe.
 */
import type { InboxItem } from './types';
import { APP_TZ } from '@/lib/time';

/** "now" · "4 min" · "3 h" · "Mon" (this week) · "Oct 12" · "Oct 12, 2025". */
export function ago(iso: string, now: Date = new Date(), timeZone: string = APP_TZ): string {
  const t = new Date(iso);
  const s = Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  if (s < 6 * 86_400) return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(t);
  const sameYear = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(t) === new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(now);
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(t);
}

export const needsYou = (i: Pick<InboxItem, 'severity' | 'readAt' | 'doneAt'>): boolean => i.severity !== 'info' && !i.readAt && !i.doneAt;

/** Unread first, then "needs you", then newest — the order the bell lists. */
export function rankForBell(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) =>
    Number(Boolean(a.readAt)) - Number(Boolean(b.readAt))
    || Number(needsYou(b)) - Number(needsYou(a))
    || b.createdAt.localeCompare(a.createdAt));
}

export interface InboxGroup {
  key: string;
  /** "J-1042 Ankeny clinic", or "Other" for rows without a job. */
  label: string;
  jobId: string | null;
  items: InboxItem[];
  unread: number;
}

/** Group a page by record (job), keeping the page order of each group's first row. */
export function groupByRecord(items: readonly InboxItem[]): InboxGroup[] {
  const out: InboxGroup[] = [];
  const at = new Map<string, InboxGroup>();
  for (const it of items) {
    const key = it.jobId ?? 'other';
    let g = at.get(key);
    if (!g) {
      g = { key, label: it.jobId ? it.jobLabel ?? 'Job' : 'Other', jobId: it.jobId, items: [], unread: 0 };
      at.set(key, g);
      out.push(g);
    }
    g.items.push(it);
    if (!it.readAt) g.unread += 1;
  }
  return out;
}

/** Where a row opens: its deep link, else its job, else the inbox. */
export function hrefOf(i: Pick<InboxItem, 'deepLink' | 'jobId'>): string {
  return i.deepLink ?? (i.jobId ? `/jobs/${i.jobId}` : '/inbox');
}
