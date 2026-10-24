import { describe, expect, it } from 'vitest';
import type { ClockCommand, FieldTimeEntry, TimeUpdateCommand } from './contract';
import type { QueuedCommand, QueueStatus } from './queue';
import { totalHours, weekLines } from './overlay';

const dayOf = (iso: string) => iso.slice(0, 10);
const entry = (over: Partial<FieldTimeEntry>): FieldTimeEntry => ({
  id: 'e1', jobId: 'job', employeeId: 'me', workDate: '2026-10-21', hours: 8, costCodeId: null, notes: null, state: 'DRAFT', commandRef: null, updatedAt: null, ...over,
});
const queued = (command: ClockCommand | TimeUpdateCommand, status: QueueStatus = 'pending', reason?: string): QueuedCommand => ({
  id: command.id, seq: 1, kind: command.kind, command, status, attempts: 0, nextAttemptAt: 0, createdAt: 0, updatedAt: 0, lastError: null,
  result: reason ? { id: command.id, kind: command.kind, outcome: 'rejected', reason } : null, fileUri: null, dependsOn: null,
});
const out = (startId: string, startAt: string, at: string): ClockCommand => ({ id: `o-${startId}`, at, kind: 'clock', event: 'OUT', jobId: 'job', segment: { startId, startAt } });

describe('my week: field-owned values win on the phone until approved', () => {
  it('a clock-out still in the queue shows as a waiting line', () => {
    const lines = weekLines([], [queued(out('s1', '2026-10-22T13:00:00Z', '2026-10-22T21:30:00Z'))], dayOf, '2026-10-19', '2026-10-25');
    expect(lines).toEqual([{ key: 'local:wf:seg:s1', entryId: null, jobId: 'job', workDate: '2026-10-22', hours: 8.5, costCodeId: null, state: 'DRAFT', waiting: true, refused: null }]);
    expect(totalHours(lines)).toBe(8.5);
  });

  it('a corrected clock-out overrides the server’s hours for the same segment', () => {
    const lines = weekLines([entry({ commandRef: 'wf:seg:s1', hours: 4 })], [queued(out('s1', '2026-10-21T13:00:00Z', '2026-10-21T19:00:00Z'))], dayOf, '2026-10-19', '2026-10-25');
    expect(lines[0]).toMatchObject({ entryId: 'e1', hours: 6, waiting: true });
  });

  it('a pending correction wins over a DRAFT, but approved time keeps the server’s value', () => {
    const fix: TimeUpdateCommand = { id: 'u1', at: '2026-10-24T12:00:00Z', kind: 'time.update', entryId: 'e1', hours: 7.5 };
    expect(weekLines([entry({})], [queued(fix)], dayOf, '2026-10-19', '2026-10-25')[0]).toMatchObject({ hours: 7.5, waiting: true });
    expect(weekLines([entry({ state: 'APPROVED' })], [queued(fix)], dayOf, '2026-10-19', '2026-10-25')[0]).toMatchObject({ hours: 8, waiting: false });
  });

  it('a refused change shows the server’s value with the reason', () => {
    const fix: TimeUpdateCommand = { id: 'u1', at: '2026-10-24T12:00:00Z', kind: 'time.update', entryId: 'e1', hours: 7.5 };
    const [l] = weekLines([entry({ state: 'APPROVED' })], [queued(fix, 'rejected', 'Your supervisor already approved this time.')], dayOf, '2026-10-19', '2026-10-25');
    expect(l).toMatchObject({ hours: 8, refused: 'Your supervisor already approved this time.' });
  });

  it('done commands do not double count once the server has the entry', () => {
    const lines = weekLines([entry({ commandRef: 'wf:seg:s1', hours: 8.5 })], [queued(out('s1', '2026-10-21T13:00:00Z', '2026-10-21T21:30:00Z'), 'done')], dayOf, '2026-10-19', '2026-10-25');
    expect(lines).toHaveLength(1);
    expect(totalHours(lines)).toBe(8.5);
  });

  it('crew punches are not my hours; void and out-of-week lines are hidden', () => {
    const crewOut: ClockCommand = { ...out('s2', '2026-10-22T13:00:00Z', '2026-10-22T14:00:00Z'), crewEmployeeIds: ['e9'] };
    const lines = weekLines([entry({ state: 'VOID' }), entry({ id: 'old', workDate: '2026-10-01' })], [queued(crewOut)], dayOf, '2026-10-19', '2026-10-25');
    expect(lines).toEqual([]);
  });
});
