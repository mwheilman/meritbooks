/**
 * Dispatch board slot math. Pure (unit-tested): the board lays out one day in the app time
 * zone, minutes from local midnight, half-open intervals [start, end) like the tstzrange in
 * pm.dispatch_assignments. The overlap check here is a CLIENT HINT so the dispatcher sees the
 * clash before submitting; pm.schedule_work_order and the gist exclusion constraint decide.
 */

export interface Interval {
  start: number; // minutes from local midnight
  end: number;
}

export interface Block extends Interval {
  id: string;
  label: string;
}

/** The board's visible hours (local). */
export const GRID_START_MIN = 6 * 60;
export const GRID_END_MIN = 20 * 60;
export const SLOT_MIN = 30;

/** "[\"2026-10-20 14:00:00+00\",\"2026-10-20 15:30:00+00\")" → ISO instants. */
export function parseSlot(slot: string): { start: string; end: string } | null {
  const m = /^[[(]\s*"?([^",]+)"?\s*,\s*"?([^",)\]]+)"?\s*[)\]]$/.exec(slot.trim());
  if (!m) return null;
  const toIso = (s: string): string | null => {
    let t = s.trim().replace(' ', 'T');
    // "+00" → "+00:00"; "+05:30" stays
    t = t.replace(/([+-]\d{2})$/, '$1:00');
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const start = toIso(m[1]!);
  const end = toIso(m[2]!);
  return start && end ? { start, end } : null;
}

/** Offset (ms) of `tz` from UTC at instant `t`: local wall clock − UTC. */
export function tzOffsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Local wall time (date + minutes after midnight in `tz`) → UTC instant. DST-safe. */
export function zonedToUtc(dayIso: string, minutes: number, tz: string): Date {
  const [y, mo, d] = dayIso.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  let t = wall - tzOffsetMs(wall, tz);
  // second pass settles transitions where the first guess sat on the other side of the shift
  t = wall - tzOffsetMs(t, tz);
  return new Date(t);
}

/** UTC instant → { day, minutes } on the local wall clock of `tz`. */
export function localParts(iso: string, tz: string): { day: string; minutes: number } {
  const t = Date.parse(iso);
  const local = new Date(t + tzOffsetMs(t, tz));
  const day = local.toISOString().slice(0, 10);
  return { day, minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** [start, end) of a local day as UTC ISO strings (for the assignments query). */
export function dayBoundsUtc(dayIso: string, tz: string): { from: string; to: string } {
  const next = new Date(`${dayIso}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from: zonedToUtc(dayIso, 0, tz).toISOString(), to: zonedToUtc(next.toISOString().slice(0, 10), 0, tz).toISOString() };
}

/** A slot's position on the given local day, clipped to the day (null when it is on another day). */
export function slotOnDay(slot: { start: string; end: string }, dayIso: string, tz: string): Interval | null {
  const s = localParts(slot.start, tz);
  const e = localParts(slot.end, tz);
  const start = s.day < dayIso ? 0 : s.day > dayIso ? null : s.minutes;
  const end = e.day > dayIso ? 24 * 60 : e.day < dayIso ? null : e.minutes;
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

/** Half-open intervals overlap (touching end-to-start does not). Same rule as tstzrange &&. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The first existing block a candidate collides with, or null. */
export function findOverlap(existing: ReadonlyArray<Block>, candidate: Interval, ignoreIds: ReadonlyArray<string> = []): Block | null {
  return existing.find((b) => !ignoreIds.includes(b.id) && overlaps(b, candidate)) ?? null;
}

/** Default visit length: the estimate rounded up to 15 minutes; 60 when there is none. */
export function defaultDuration(estimatedMinutes: number | null | undefined): number {
  if (!estimatedMinutes || estimatedMinutes <= 0) return 60;
  return Math.ceil(estimatedMinutes / 15) * 15;
}

/** Start minutes offered on the board (every 30 minutes between the grid bounds). */
export function slotStarts(from = GRID_START_MIN, to = GRID_END_MIN, step = SLOT_MIN): number[] {
  const out: number[] = [];
  for (let m = from; m < to; m += step) out.push(m);
  return out;
}

/** "9:30 AM" for minutes after midnight. */
export function clockOf(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "09:30" for an <input type="time">. */
export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "09:30" → 570; null when unparseable. */
export function parseHhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** "1 h 30 min" · "45 min" · "2 h". */
export function durationText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

/** Percent position of an interval on the visible grid. */
export function gridGeometry(iv: Interval, from = GRID_START_MIN, to = GRID_END_MIN): { left: number; width: number } | null {
  const s = Math.max(iv.start, from);
  const e = Math.min(iv.end, to);
  if (e <= s) return null;
  const span = to - from;
  return { left: ((s - from) / span) * 100, width: ((e - s) / span) * 100 };
}

export interface Capacity {
  booked: number;
  capacity: number;
  free: number;
  /** 0..1 (capped at 1 for the bar; `over` says when it is past). */
  fill: number;
  over: boolean;
  text: string;
}

/** Booked vs capacity minutes for one technician-day. */
export function capacityOf(booked: number, capacity: number): Capacity {
  const cap = Math.max(0, capacity);
  const free = cap - booked;
  const over = booked > cap;
  const fill = cap > 0 ? Math.min(1, booked / cap) : booked > 0 ? 1 : 0;
  const text = over
    ? `${durationText(booked)} booked, ${durationText(-free)} over the ${durationText(cap)} day`
    : `${durationText(booked)} of ${durationText(cap)} booked, ${durationText(free)} free`;
  return { booked, capacity: cap, free, fill, over, text };
}

/** Required skill codes the assigned people do not hold (client hint for PM_SKILL_MISMATCH). */
export function missingSkills(required: ReadonlyArray<string>, held: ReadonlyArray<string>): string[] {
  const have = new Set(held);
  return required.filter((r) => !have.has(r));
}

/** Total booked minutes of intervals (overlaps counted once). */
export function bookedMinutes(ivs: ReadonlyArray<Interval>): number {
  const sorted = [...ivs].sort((a, b) => a.start - b.start);
  let total = 0;
  let curS = -1;
  let curE = -1;
  for (const iv of sorted) {
    if (iv.start >= curE) {
      if (curE > curS) total += curE - curS;
      curS = iv.start;
      curE = iv.end;
    } else if (iv.end > curE) {
      curE = iv.end;
    }
  }
  if (curE > curS) total += curE - curS;
  return total;
}

/** The arrival window as one phrase for a queue row. */
export function windowText(start: string | null, end: string | null, tz: string, today: string): string | null {
  if (!start) return null;
  const s = localParts(start, tz);
  const dayWord = s.day === today ? 'Today' : s.day;
  if (!end) return `${dayWord} from ${clockOf(s.minutes)}`;
  const e = localParts(end, tz);
  return e.day === s.day ? `${dayWord} ${clockOf(s.minutes)}–${clockOf(e.minutes)}` : `${dayWord} ${clockOf(s.minutes)} to ${e.day} ${clockOf(e.minutes)}`;
}

/** ISO date `days` after `iso` (calendar math in UTC so it never shifts). */
export function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
