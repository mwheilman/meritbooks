/**
 * Waiting-on-you queue helpers (client-safe, pure): where each item opens, how urgent it is, and
 * the order the person sees (overdue first, then by deadline; items already answered last).
 */
import { booksPayUrl, daysUntil } from './format';
import type { QueueItem } from './types';

export function itemHref(orgId: string, i: QueueItem): string {
  const o = `/portal/o/${orgId}`;
  switch (i.kind) {
    case 'estimate':
    case 'change_order':
    case 'selection':
    case 'commitment':
      return `${o}/items/${i.kind}/${i.id}`;
    case 'draw':
      return `${o}/draws/${i.id}`;
    case 'invoice':
      return i.pay_token ? booksPayUrl(i.pay_token) : `${o}/invoices`;
    case 'compliance':
      return `${o}/work#compliance`;
    case 'assignment':
    case 'punch':
    case 'signature':
      return i.job ? `${o}/jobs/${i.job.id}` : o;
  }
}

/** The pip shape + word on the card (status is never colour alone). */
export function urgency(i: QueueItem, now: Date = new Date()): 'overdue' | 'risk' | 'track' | 'ready' {
  if (i.state === 'sent') return 'ready';
  if (i.state === 'overdue') return 'overdue';
  const n = daysUntil(i.deadline ?? null, now);
  if (n !== null && n < 0) return 'overdue';
  if (n !== null && n <= 3) return 'risk';
  return 'track';
}

const RANK = { overdue: 0, risk: 1, track: 2, ready: 3 } as const;

export function sortQueue(items: readonly QueueItem[], now: Date = new Date()): QueueItem[] {
  return [...items].sort((a, b) => {
    const r = RANK[urgency(a, now)] - RANK[urgency(b, now)];
    if (r !== 0) return r;
    const da = a.deadline ?? '9999-12-31'; const db = b.deadline ?? '9999-12-31';
    return da < db ? -1 : da > db ? 1 : a.title.localeCompare(b.title);
  });
}

/** Opens Books' hosted page in a new tab (an external origin). */
export function isExternal(href: string): boolean {
  return /^https?:\/\//.test(href);
}
