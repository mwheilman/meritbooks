import { describe, expect, it } from 'vitest';
import { ClockError, IDLE, buttons, durationText, step, workedMs } from './clock';

const JOB = 'job-1';
const JOB2 = 'job-2';
const here = { lat: 41.6, lng: -93.6, accuracyM: 10 };

describe('one big button: On my way → Clock in → Break → Clock out', () => {
  it('walks a shift and emits the right commands with original times and GPS', () => {
    expect(buttons(IDLE, true).primary).toBe('EN_ROUTE');
    const a = step(IDLE, 'EN_ROUTE', { id: 'c1', at: '2026-10-24T12:30:00Z', geo: here, jobId: JOB, assignmentId: 'v1', costCodeId: 'cc' });
    expect(a.command).toMatchObject({ kind: 'clock', event: 'EN_ROUTE', jobId: JOB, assignmentId: 'v1', geo: here });
    expect(buttons(a.next, true).primary).toBe('IN');

    const b = step(a.next, 'IN', { id: 'c2', at: '2026-10-24T13:00:00Z', geo: here });
    expect(b.next).toMatchObject({ phase: 'working', jobId: JOB, costCodeId: 'cc', assignmentId: 'v1', segment: { startId: 'c2', startAt: '2026-10-24T13:00:00Z' } });
    expect(buttons(b.next, true)).toEqual({ primary: 'BREAK_START', secondary: ['OUT', 'SWITCH'] });

    const c = step(b.next, 'BREAK_START', { id: 'c3', at: '2026-10-24T17:00:00Z', geo: here });
    expect(c.command).toMatchObject({ event: 'BREAK_START', segment: { startId: 'c2', startAt: '2026-10-24T13:00:00Z', startGeo: here } });
    expect(c.next.phase).toBe('break');
    expect(buttons(c.next, true).primary).toBe('BREAK_END');

    const d = step(c.next, 'BREAK_END', { id: 'c4', at: '2026-10-24T17:30:00Z', geo: here });
    expect(d.next.segment?.startId).toBe('c4');
    expect(buttons(d.next, true)).toEqual({ primary: 'OUT', secondary: ['BREAK_START', 'SWITCH'] });
    expect(workedMs(d.next, Date.parse('2026-10-24T18:30:00Z'))).toBe(5 * 3_600_000);

    const e = step(d.next, 'OUT', { id: 'c5', at: '2026-10-24T21:30:00Z', geo: null });
    expect(e.command).toMatchObject({ event: 'OUT', segment: { startId: 'c4' } });
    expect(e.next).toEqual(IDLE);
  });

  it('without a visit the big button is Clock in', () => {
    expect(buttons(IDLE, false)).toEqual({ primary: 'IN', secondary: [] });
  });

  it('switching job closes the segment on the old job and opens one on the new', () => {
    const w = step(IDLE, 'IN', { id: 'i', at: '2026-10-24T13:00:00Z', geo: null, jobId: JOB });
    const s = step(w.next, 'SWITCH', { id: 's', at: '2026-10-24T15:00:00Z', geo: null, jobId: JOB2, costCodeId: 'cc2' });
    expect(s.command).toMatchObject({ event: 'SWITCH', jobId: JOB, segment: { startId: 'i' } });
    expect(s.next).toMatchObject({ jobId: JOB2, costCodeId: 'cc2', segment: { startId: 's' }, workedMs: 2 * 3_600_000 });
  });

  it('clock out while on break records nothing more (the break already closed the segment)', () => {
    const w = step(IDLE, 'IN', { id: 'i', at: '2026-10-24T13:00:00Z', geo: null, jobId: JOB });
    const b = step(w.next, 'BREAK_START', { id: 'b', at: '2026-10-24T15:00:00Z', geo: null });
    expect(step(b.next, 'OUT', { id: 'o', at: '2026-10-24T15:10:00Z', geo: null })).toEqual({ next: IDLE, command: null });
  });

  it('a foreman’s crew shift carries the crew on every command', () => {
    const w = step(IDLE, 'IN', { id: 'i', at: '2026-10-24T13:00:00Z', geo: null, jobId: JOB, crewEmployeeIds: ['e1', 'e2'] });
    const o = step(w.next, 'OUT', { id: 'o', at: '2026-10-24T14:00:00Z', geo: null });
    expect(o.command?.crewEmployeeIds).toEqual(['e1', 'e2']);
  });

  it('refuses steps that make no sense, in plain words', () => {
    expect(() => step(IDLE, 'OUT', { id: 'x', at: '2026-10-24T13:00:00Z', geo: null })).toThrow(ClockError);
    expect(() => step(IDLE, 'IN', { id: 'x', at: '2026-10-24T13:00:00Z', geo: null })).toThrow('Pick the job first.');
    const w = step(IDLE, 'IN', { id: 'i', at: '2026-10-24T13:00:00Z', geo: null, jobId: JOB });
    expect(() => step(w.next, 'IN', { id: 'x', at: '2026-10-24T13:05:00Z', geo: null })).toThrow('You are already clocked in.');
    expect(() => step(w.next, 'OUT', { id: 'x', at: '2026-10-24T12:00:00Z', geo: null })).toThrow(/backwards/);
  });

  it('formats durations', () => {
    expect(durationText(161 * 60_000)).toBe('2 h 41 m');
    expect(durationText(5 * 60_000)).toBe('5 m');
  });
});
