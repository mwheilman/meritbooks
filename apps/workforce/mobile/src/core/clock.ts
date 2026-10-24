/**
 * The shift on the phone: one big button walks it forward
 *   On my way → Clock in → Break → End break → Clock out
 * and every step becomes a clock command for the queue. Closing steps (break, clock out, switch
 * job) carry the segment they close, so the server can make the time entry even if the clock-in
 * reached it hours later or out of order. Pure (unit-tested).
 */
import type { ClockCommand, ClockEvent, Geo } from './contract';

export type Phase = 'idle' | 'en_route' | 'working' | 'break';

export interface OpenSegment {
  startId: string;
  startAt: string;
  startGeo: Geo | null;
}

export interface ShiftState {
  phase: Phase;
  jobId: string | null;
  costCodeId: string | null;
  assignmentId: string | null;
  /** Foreman crew clock: who this shift is for (empty = me). */
  crewEmployeeIds: string[];
  segment: OpenSegment | null;
  shiftStartedAt: string | null;
  breakStartedAt: string | null;
  tookBreak: boolean;
  /** Worked time in closed segments of this shift. */
  workedMs: number;
}

export const IDLE: ShiftState = {
  phase: 'idle', jobId: null, costCodeId: null, assignmentId: null, crewEmployeeIds: [], segment: null,
  shiftStartedAt: null, breakStartedAt: null, tookBreak: false, workedMs: 0,
};

export interface ClockButtons {
  primary: ClockEvent;
  secondary: ClockEvent[];
}

/** What the big button does next, and what the smaller buttons under it offer. */
export function buttons(s: ShiftState, hasVisit: boolean): ClockButtons {
  switch (s.phase) {
    case 'idle': return hasVisit ? { primary: 'EN_ROUTE', secondary: ['IN'] } : { primary: 'IN', secondary: [] };
    case 'en_route': return { primary: 'IN', secondary: [] };
    case 'working': return s.tookBreak ? { primary: 'OUT', secondary: ['BREAK_START', 'SWITCH'] } : { primary: 'BREAK_START', secondary: ['OUT', 'SWITCH'] };
    case 'break': return { primary: 'BREAK_END', secondary: ['OUT'] };
  }
}

export interface StepInput {
  /** The new command's id (the idempotency key) and when it happened. */
  id: string;
  at: string;
  geo: Geo | null;
  /** Job / cost code / visit: required for EN_ROUTE and IN from idle, and for the new job on SWITCH. */
  jobId?: string | null;
  costCodeId?: string | null;
  assignmentId?: string | null;
  crewEmployeeIds?: string[];
}

export type ClockDraft = Omit<ClockCommand, 'tz' | 'offline'>;

export interface Step {
  next: ShiftState;
  /** null when the step changes only the phone (clock out while on break: nothing left to record). */
  command: ClockDraft | null;
}

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockError';
  }
}

const ms = (a: string, b: string) => Math.max(0, Date.parse(b) - Date.parse(a));

export function step(s: ShiftState, event: ClockEvent, i: StepInput): Step {
  const crew = i.crewEmployeeIds ?? s.crewEmployeeIds;
  const crewPart = crew.length ? { crewEmployeeIds: crew } : {};
  switch (event) {
    case 'EN_ROUTE': {
      if (s.phase !== 'idle') throw new ClockError('You are already on the clock.');
      if (!i.jobId) throw new ClockError('Pick the job first.');
      const next: ShiftState = { ...IDLE, phase: 'en_route', jobId: i.jobId, costCodeId: i.costCodeId ?? null, assignmentId: i.assignmentId ?? null, crewEmployeeIds: crew };
      return { next, command: { id: i.id, at: i.at, geo: i.geo, kind: 'clock', event, jobId: i.jobId, costCodeId: next.costCodeId, assignmentId: next.assignmentId, ...crewPart } };
    }
    case 'IN': {
      if (s.phase !== 'idle' && s.phase !== 'en_route') throw new ClockError('You are already clocked in.');
      const jobId = i.jobId ?? s.jobId;
      if (!jobId) throw new ClockError('Pick the job first.');
      const costCodeId = i.costCodeId !== undefined ? i.costCodeId : s.costCodeId;
      const assignmentId = i.assignmentId !== undefined ? i.assignmentId : s.assignmentId;
      const next: ShiftState = {
        ...IDLE, phase: 'working', jobId, costCodeId: costCodeId ?? null, assignmentId: assignmentId ?? null, crewEmployeeIds: crew,
        segment: { startId: i.id, startAt: i.at, startGeo: i.geo }, shiftStartedAt: i.at,
      };
      return { next, command: { id: i.id, at: i.at, geo: i.geo, kind: 'clock', event, jobId, costCodeId: next.costCodeId, assignmentId: next.assignmentId, ...crewPart } };
    }
    case 'BREAK_START':
    case 'OUT':
    case 'SWITCH': {
      if (event === 'OUT' && s.phase === 'break') {
        // Already off the clock for the break: the last segment was recorded when the break began.
        return { next: { ...IDLE }, command: null };
      }
      if (s.phase !== 'working' || !s.segment || !s.jobId) throw new ClockError('You are not clocked in.');
      if (Date.parse(i.at) < Date.parse(s.segment.startAt)) throw new ClockError('The phone’s clock went backwards. Check the date and time.');
      const command: ClockDraft = {
        id: i.id, at: i.at, geo: i.geo, kind: 'clock', event, jobId: s.jobId, costCodeId: s.costCodeId, assignmentId: s.assignmentId,
        segment: { startId: s.segment.startId, startAt: s.segment.startAt, startGeo: s.segment.startGeo }, ...crewPart,
      };
      const workedMs = s.workedMs + ms(s.segment.startAt, i.at);
      if (event === 'OUT') return { next: { ...IDLE }, command };
      if (event === 'BREAK_START') return { next: { ...s, phase: 'break', segment: null, breakStartedAt: i.at, tookBreak: true, workedMs }, command };
      if (!i.jobId) throw new ClockError('Pick the job you are switching to.');
      return {
        next: { ...s, jobId: i.jobId, costCodeId: i.costCodeId ?? null, assignmentId: i.assignmentId ?? null, segment: { startId: i.id, startAt: i.at, startGeo: i.geo }, workedMs },
        command,
      };
    }
    case 'BREAK_END': {
      if (s.phase !== 'break' || !s.jobId) throw new ClockError('You are not on a break.');
      return {
        next: { ...s, phase: 'working', segment: { startId: i.id, startAt: i.at, startGeo: i.geo }, breakStartedAt: null },
        command: { id: i.id, at: i.at, geo: i.geo, kind: 'clock', event, jobId: s.jobId, costCodeId: s.costCodeId, assignmentId: s.assignmentId, ...crewPart },
      };
    }
  }
}

/** Worked time so far in this shift (closed segments + the open one). */
export function workedMs(s: ShiftState, nowMs: number): number {
  const open = s.phase === 'working' && s.segment ? Math.max(0, nowMs - Date.parse(s.segment.startAt)) : 0;
  return s.workedMs + open;
}

/** "2 h 41 m" */
export function durationText(msValue: number): string {
  const m = Math.floor(msValue / 60_000);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} m` : `${m} m`;
}

export function isShiftState(v: unknown): v is ShiftState {
  if (typeof v !== 'object' || v === null) return false;
  const p = (v as { phase?: unknown }).phase;
  return p === 'idle' || p === 'en_route' || p === 'working' || p === 'break';
}
