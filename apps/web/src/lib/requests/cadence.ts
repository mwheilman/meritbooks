/**
 * Cadence + quiet-hours math for the request engine. PURE — no I/O, no clock reads
 * (every function takes `now`), so the schedule is unit-testable across time zones and
 * DST changes.
 *
 * MODEL. A request's send slots are `base + offsets[i]` for each offset, then every
 * `repeatEveryMinutes` after the last offset. `base` is the creation time (anchor
 * 'created', e.g. day 0 / 3 / 7) or the due date at 09:00 recipient-local (anchor 'due',
 * e.g. T-30 / T-15 / T-0). After a send the engine moves to the FIRST slot later than
 * now, so a late request sends once — never a burst of catch-up messages.
 *
 * QUIET HOURS. A send that lands inside the recipient's quiet window (local wall time in
 * an IANA zone) moves to the window's end. Wall-clock → instant conversion re-checks the
 * zone offset at the target, so 07:00 is 07:00 on both sides of a DST change.
 */

import type { Cadence, CadenceAnchor, QuietHours } from './types';

const MIN_MS = 60_000;
/** Due-anchored requests are asked at 09:00 recipient-local on the anchor day. */
export const DUE_ANCHOR_HOUR = 9;

// ── time zones ───────────────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    fmt(tz).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** The first valid IANA zone among the candidates, else 'UTC'. */
export function resolveTimeZone(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) if (isValidTimeZone(c)) return c;
  return 'UTC';
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedParts(d: Date, tz: string): ZonedParts {
  const parts = fmt(tz).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  };
}

/** Zone offset at instant `d` in ms (local wall clock − UTC). */
export function tzOffsetMs(d: Date, tz: string): number {
  const p = zonedParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** The instant whose wall-clock time in `tz` is y-m-d h:mi (DST-safe). */
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

// ── quiet hours ──────────────────────────────────────────────────────────────

/** "HH:MM" or "HH:MM:SS" → minutes after midnight, or null when malformed. */
export function parseClock(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function quietHoursOf(start: string | null | undefined, end: string | null | undefined): QuietHours | null {
  const s = parseClock(start);
  const e = parseClock(end);
  if (s == null || e == null || s === e) return null;
  return { start: String(start).slice(0, 5), end: String(end).slice(0, 5) };
}

export function inQuietHours(d: Date, quiet: QuietHours | null, tz: string): boolean {
  if (!quiet) return false;
  const s = parseClock(quiet.start);
  const e = parseClock(quiet.end);
  if (s == null || e == null || s === e) return false;
  const p = zonedParts(d, tz);
  const m = p.hour * 60 + p.minute;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** `d`, or the end of the quiet window it falls in (recipient-local, DST-safe). */
export function deferForQuietHours(d: Date, quiet: QuietHours | null, tz: string): Date {
  if (!quiet || !inQuietHours(d, quiet, tz)) return d;
  const s = parseClock(quiet.start) as number;
  const e = parseClock(quiet.end) as number;
  const p = zonedParts(d, tz);
  const m = p.hour * 60 + p.minute;
  // Wrapping window (21:00–06:00): before midnight the end is TOMORROW.
  const nextDay = s > e && m >= s;
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + (nextDay ? 1 : 0)));
  return localToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(e / 60), e % 60, tz);
}

// ── cadence ──────────────────────────────────────────────────────────────────

/** The instant a request's slots are measured from. */
export function anchorBase(anchor: CadenceAnchor, createdAt: Date, dueDate: string | null, tz: string): Date {
  if (anchor === 'due' && dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    const [y, m, d] = dueDate.split('-').map(Number);
    return localToUtc(y, m, d, DUE_ANCHOR_HOUR, 0, tz);
  }
  return createdAt;
}

/** When slot `slot` (1-based) falls, or null when the cadence has no such slot. */
export function slotTime(c: Cadence, base: Date, slot: number): Date | null {
  const n = c.offsetsMinutes.length;
  if (slot < 1 || n === 0) return null;
  if (slot <= n) return new Date(base.getTime() + c.offsetsMinutes[slot - 1] * MIN_MS);
  if (!c.repeatEveryMinutes || c.repeatEveryMinutes <= 0) return null;
  return new Date(base.getTime() + (c.offsetsMinutes[n - 1] + (slot - n) * c.repeatEveryMinutes) * MIN_MS);
}

/** The first slot ≥ `fromSlot` whose time is strictly after `after`, or null (cadence exhausted). */
export function nextSlotAfter(c: Cadence, base: Date, after: Date, fromSlot: number): { slot: number; at: Date } | null {
  const n = c.offsetsMinutes.length;
  const start = Math.max(1, fromSlot);
  for (let s = start; s <= n; s++) {
    const t = slotTime(c, base, s) as Date;
    if (t.getTime() > after.getTime()) return { slot: s, at: t };
  }
  if (!c.repeatEveryMinutes || c.repeatEveryMinutes <= 0 || n === 0) return null;
  const last = base.getTime() + c.offsetsMinutes[n - 1] * MIN_MS;
  const step = c.repeatEveryMinutes * MIN_MS;
  const k = Math.max(1, Math.floor((after.getTime() - last) / step) + 1);
  const slot = Math.max(n + k, start);
  const at = slotTime(c, base, slot) as Date;
  // floating point / boundary guard: always strictly after
  if (at.getTime() <= after.getTime()) return { slot: slot + 1, at: slotTime(c, base, slot + 1) as Date };
  return { slot, at };
}

/** A new request's first send: slot 1's time, or `now` when slot 1 is already past. */
export function initialSchedule(c: Cadence, base: Date, now: Date): { slot: number; at: Date } {
  const t = slotTime(c, base, 1) ?? now;
  return { slot: 1, at: t.getTime() <= now.getTime() ? now : t };
}

/**
 * After a send at `now` (which consumed `slot`): the next slot strictly after now.
 * null = the cadence has no more slots (the request waits for an answer, then expires).
 */
export function afterSend(c: Cadence, base: Date, now: Date, slot: number): { slot: number; at: Date } | null {
  return nextSlotAfter(c, base, now, slot + 1);
}

export function shouldEscalate(sendsCount: number, escalateAfter: number | null, escalatedAt: string | null): boolean {
  return escalateAfter != null && escalateAfter > 0 && !escalatedAt && sendsCount >= escalateAfter;
}

// ── plain English ────────────────────────────────────────────────────────────

function span(min: number): { n: number; unit: 'day' | 'hour' | 'minute' } {
  const a = Math.abs(min);
  if (a % 1440 === 0) return { n: a / 1440, unit: 'day' };
  if (a % 60 === 0) return { n: a / 60, unit: 'hour' };
  return { n: a, unit: 'minute' };
}

function every(min: number): string {
  if (min === 10080) return 'weekly';
  if (min === 1440) return 'daily';
  const s = span(min);
  return `every ${s.n} ${s.unit}${s.n === 1 ? '' : 's'}`;
}

/** "Day 0, 3, 7, then weekly" · "T-30, T-15, T-0, then weekly" · "After 30 minutes, then every 2 hours". */
export function describeCadence(c: Pick<Cadence, 'offsetsMinutes' | 'repeatEveryMinutes'>, anchor: CadenceAnchor): string {
  const offs = c.offsetsMinutes;
  let head: string;
  if (anchor === 'due') {
    head = offs
      .map((o) => {
        const s = span(o);
        const unit = s.unit === 'day' ? '' : s.unit === 'hour' ? 'h' : 'm';
        return o === 0 ? 'T-0' : o < 0 ? `T-${s.n}${unit}` : `T+${s.n}${unit}`;
      })
      .join(', ');
  } else if (offs.every((o) => o % 1440 === 0)) {
    head = `Day ${offs.map((o) => o / 1440).join(', ')}`;
  } else {
    head = offs
      .map((o, i) => {
        if (o === 0) return i === 0 ? 'Right away' : 'again';
        const s = span(o);
        return `${i === 0 ? 'After' : 'then at'} ${s.n} ${s.unit}${s.n === 1 ? '' : 's'}`;
      })
      .join(', ');
  }
  return c.repeatEveryMinutes ? `${head}, then ${every(c.repeatEveryMinutes)}` : head;
}

/** "3, 7, 14" (days) → minutes; tolerant of spaces, rejects junk. Negative allowed for due anchors. */
export function parseDayList(input: string): number[] | null {
  const parts = input.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 12) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^-?\d{1,3}$/.test(p)) return null;
    out.push(Number(p) * 1440);
  }
  return out;
}
