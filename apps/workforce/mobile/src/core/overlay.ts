/**
 * "My week" on the phone = what the server last said + what is still in the queue. The client
 * half of the sync rule FIELD-OWNED FIELDS WIN: a clock-out or correction the worker made shows
 * immediately, over the server's value, until it is approved; once the server says APPROVED (or
 * refuses the change), the server's value shows with the reason. Pure (unit-tested).
 */
import { CLOSING_EVENTS, type ApprovalState, type ClockCommand, type FieldTimeEntry, type TimeUpdateCommand } from './contract';
import type { QueuedCommand } from './queue';

export interface WeekLine {
  key: string;
  /** Server id once it exists (needed to correct or submit it). */
  entryId: string | null;
  jobId: string;
  workDate: string;
  hours: number;
  costCodeId: string | null;
  state: ApprovalState;
  /** A change made on this phone has not reached the server yet. */
  waiting: boolean;
  /** The server refused the phone's change; this is why (the line shows the server's values). */
  refused: string | null;
}

const hoursBetween = (a: string, b: string) => Math.round((Math.max(0, Date.parse(b) - Date.parse(a)) / 3_600_000) * 100) / 100;
const OPEN = new Set(['pending', 'sending']);

export function weekLines(server: ReadonlyArray<FieldTimeEntry>, queued: ReadonlyArray<QueuedCommand>, dayOf: (iso: string) => string, weekStart: string, weekEnd: string): WeekLine[] {
  const lines = new Map<string, WeekLine>();
  const byRef = new Map<string, string>();
  for (const e of server) {
    if (e.state === 'VOID') continue;
    lines.set(e.id, { key: e.id, entryId: e.id, jobId: e.jobId, workDate: e.workDate, hours: e.hours, costCodeId: e.costCodeId, state: e.state, waiting: false, refused: null });
    if (e.commandRef) byRef.set(e.commandRef, e.id);
  }

  for (const q of queued) {
    const open = OPEN.has(q.status);
    const refused = q.status === 'rejected' ? q.result?.reason ?? 'The office could not accept this change.' : null;
    if (!open && !refused) continue;

    if (q.command.kind === 'clock') {
      const c: ClockCommand = q.command;
      if (!CLOSING_EVENTS.has(c.event) || !c.segment || (c.crewEmployeeIds ?? []).length) continue;
      const ref = `wf:seg:${c.segment.startId}`;
      const existingId = byRef.get(ref);
      const existing = existingId ? lines.get(existingId) : undefined;
      if (existing) {
        if (refused) existing.refused = refused;
        else if (existing.state !== 'APPROVED') Object.assign(existing, { hours: hoursBetween(c.segment.startAt, c.at), costCodeId: c.costCodeId ?? null, waiting: true });
        continue;
      }
      if (refused) continue; // never reached the server: shown in the "Not saved" list instead
      const key = `local:${ref}`;
      lines.set(key, {
        key, entryId: null, jobId: c.jobId, workDate: dayOf(c.segment.startAt), hours: hoursBetween(c.segment.startAt, c.at),
        costCodeId: c.costCodeId ?? null, state: 'DRAFT', waiting: true, refused: null,
      });
      continue;
    }

    if (q.command.kind === 'time.update') {
      const u: TimeUpdateCommand = q.command;
      const line = lines.get(u.entryId);
      if (!line) continue;
      if (refused) { line.refused = refused; continue; }
      if (line.state === 'APPROVED') continue; // the office's approval wins over a late change
      if (u.hours !== undefined) line.hours = u.hours;
      if (u.costCodeId !== undefined) line.costCodeId = u.costCodeId ?? null;
      if (u.workDate !== undefined) line.workDate = u.workDate;
      line.waiting = true;
      continue;
    }

    if (q.command.kind === 'time.submit' && open) {
      for (const id of q.command.entryIds) {
        const line = lines.get(id);
        if (line && (line.state === 'DRAFT' || line.state === 'REJECTED')) Object.assign(line, { state: 'SUBMITTED' as const, waiting: true });
      }
    }
  }

  return [...lines.values()]
    .filter((l) => l.workDate >= weekStart && l.workDate <= weekEnd)
    .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.key.localeCompare(b.key));
}

export function totalHours(lines: ReadonlyArray<WeekLine>): number {
  return Math.round(lines.reduce((s, l) => s + l.hours, 0) * 100) / 100;
}
