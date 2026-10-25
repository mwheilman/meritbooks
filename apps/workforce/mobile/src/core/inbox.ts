/**
 * The notification inbox on the phone: the server's page (cached for offline) plus read / done
 * marks made on this phone that have not reached it yet. Pure (unit-tested).
 */
import type { InboxItem, InboxPage, NotificationMarkCommand } from './contract';
import type { QueuedCommand } from './queue';

const KEPT = new Set(['pending', 'sending', 'done']);

export function overlayInbox(page: InboxPage | null, queued: ReadonlyArray<QueuedCommand>, now = new Date().toISOString()): { items: InboxItem[]; unread: number } {
  if (!page) return { items: [], unread: 0 };
  const read = new Set<string>();
  const done = new Set<string>();
  for (const q of queued) {
    if (q.command.kind !== 'notification.mark' || !KEPT.has(q.status)) continue;
    const c = q.command as NotificationMarkCommand;
    for (const id of c.ids) (c.state === 'done' ? done : read).add(id);
  }
  const items = page.items
    .filter((i) => !i.doneAt && !done.has(i.id))
    .map((i) => (i.readAt || !read.has(i.id) ? i : { ...i, readAt: now }));
  const changed = page.items.filter((i) => !i.readAt && (read.has(i.id) || done.has(i.id))).length;
  return { items, unread: Math.max(0, page.unread - changed) };
}

export function markDraft(ids: ReadonlyArray<string>, state: 'read' | 'done'): Omit<NotificationMarkCommand, 'id' | 'at' | 'tz' | 'geo' | 'offline'> {
  return { kind: 'notification.mark', ids: [...new Set(ids)].slice(0, 200), state };
}

export function isInboxPage(v: unknown): v is InboxPage {
  return typeof v === 'object' && v !== null && Array.isArray((v as InboxPage).items) && typeof (v as InboxPage).unread === 'number';
}
