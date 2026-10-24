/**
 * Bar drag math: pixels → a new start (move) or a new duration (resize), snapped to the job's
 * working days, and the words the undo toast uses. Pure.
 */
import { addWorkdays, dayNum, isoOf, isWorkday, workdaysBetween, workdaysInclusive } from './calendar';
import type { WorkCalendar } from './types';

/** Whole days a horizontal drag covers at `ppd` px per day (nearest day, the same both ways). */
export function dragDays(dx: number, ppd: number): number {
  if (!ppd) return 0;
  const n = Math.sign(dx) * Math.round(Math.abs(dx) / ppd);
  return n === 0 ? 0 : n; // never -0
}

/** Snap a day to a working day: forward when moving later, backward when moving earlier. */
export function snapWorkday(cal: WorkCalendar, iso: string, dir: 1 | -1): string {
  if (isWorkday(cal, iso)) return iso;
  let n = dayNum(iso);
  for (let g = 0; g < 400; g++) {
    n += dir;
    if (isWorkday(cal, isoOf(n))) return isoOf(n);
  }
  return iso;
}

/** New start for a middle drag of `dx` px; null when the bar didn't move a whole day. */
export function moveStart(cal: WorkCalendar, start: string, dx: number, ppd: number): string | null {
  const days = dragDays(dx, ppd);
  if (!days) return null;
  const raw = isoOf(dayNum(start) + days);
  const snapped = snapWorkday(cal, raw, days > 0 ? 1 : -1);
  return snapped === start ? null : snapped;
}

/**
 * New duration (working days, ≥ 1) for a right-edge drag of `dx` px, or null when unchanged.
 * The finish follows the pointer, snapped back to the last working day at or before it.
 */
export function resizeDuration(cal: WorkCalendar, start: string, finish: string, dx: number, ppd: number): number | null {
  const days = dragDays(dx, ppd);
  if (!days) return null;
  const raw = isoOf(Math.max(dayNum(start), dayNum(finish) + days));
  const f = snapWorkday(cal, raw, -1);
  const d = Math.max(1, workdaysInclusive(cal, addWorkdays(cal, start, 0), f < start ? start : f));
  const before = Math.max(1, workdaysInclusive(cal, addWorkdays(cal, start, 0), finish));
  return d === before ? null : d;
}

/** Signed working days between two project finishes. */
export function finishDelta(cal: WorkCalendar, before: string | null, after: string | null): number {
  if (!before || !after) return 0;
  return workdaysBetween(cal, before, after);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Moved 9 tasks; finish +3 days" / "Moved 1 task; finish unchanged". */
export function moveSummary(verb: 'Moved' | 'Resized' | 'Linked' | 'Updated', moved: number, delta: number): string {
  const fin = delta === 0 ? 'finish unchanged' : `finish ${delta > 0 ? '+' : '−'}${plural(Math.abs(delta), 'day', 'days')}`;
  return `${verb} ${plural(Math.max(moved, 0), 'task', 'tasks')}; ${fin}`;
}
