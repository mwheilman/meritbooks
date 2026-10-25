/**
 * Inbox shaping (pure): filter, search, and the due-date groups the queue shows.
 * The database already sorts by due date, then dollar impact.
 */
import type { ApprovalItem, ApprovalObjectType } from './types';

export interface InboxFilter {
  types?: ReadonlyArray<ApprovalObjectType>;
  text?: string;
  overdueOnly?: boolean;
}

export function filterItems(items: ReadonlyArray<ApprovalItem>, f: InboxFilter): ApprovalItem[] {
  const needle = (f.text ?? '').trim().toLowerCase();
  return items.filter((i) => {
    if (f.types && f.types.length > 0 && !f.types.includes(i.object_type)) return false;
    if (f.overdueOnly && !i.overdue) return false;
    if (!needle) return true;
    return [i.title, i.summary, i.job_label, i.company, i.prepared_by, i.step_label].some((s) => (s ?? '').toLowerCase().includes(needle));
  });
}

export type DueGroup = 'overdue' | 'today' | 'later';

export function dueGroup(i: Pick<ApprovalItem, 'due_at' | 'overdue'>, now: Date = new Date()): DueGroup {
  if (i.overdue) return 'overdue';
  if (!i.due_at) return 'later';
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return new Date(i.due_at).getTime() <= end.getTime() ? 'today' : 'later';
}

export function groupByDue(items: ReadonlyArray<ApprovalItem>, now: Date = new Date()): Array<{ id: DueGroup; rows: ApprovalItem[] }> {
  const order: DueGroup[] = ['overdue', 'today', 'later'];
  const by = new Map<DueGroup, ApprovalItem[]>(order.map((g) => [g, []]));
  for (const i of items) by.get(dueGroup(i, now))!.push(i);
  return order.map((id) => ({ id, rows: by.get(id)! })).filter((g) => g.rows.length > 0);
}

/** Types present in a list, in a stable order, with counts (the filter chips). */
export function typeCounts(items: ReadonlyArray<ApprovalItem>): Array<{ type: ApprovalObjectType; count: number }> {
  const m = new Map<ApprovalObjectType, number>();
  for (const i of items) m.set(i.object_type, (m.get(i.object_type) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type, count]) => ({ type, count }));
}

/** Bulk approval is allowed only when every selected row allows it. */
export function bulkAllowed(rows: ReadonlyArray<Pick<ApprovalItem, 'bulk_ok'>>): boolean {
  return rows.length > 0 && rows.every((r) => r.bulk_ok);
}

/** Sum of visible amounts (hidden amounts are not counted, never guessed). */
export function visibleTotal(rows: ReadonlyArray<Pick<ApprovalItem, 'amount_cents'>>): { cents: number; hidden: number } {
  let cents = 0;
  let hidden = 0;
  for (const r of rows) {
    if (r.amount_cents === null) hidden += 1;
    else cents += r.amount_cents;
  }
  return { cents, hidden };
}
