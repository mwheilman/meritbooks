/**
 * Quiet hours — the client mirror of core.notify_quiet_end (migration 1114). A window
 * [start, end) in a time zone; start > end wraps past midnight (22:00–07:00). Pushes and texts
 * that land inside it wait until it ends; the inbox copy is immediate. Pure.
 */

export interface QuietWindow {
  start: string; // "22:00" or "22:00:00"
  end: string;
}

function minutesOf(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Wall-clock parts of `at` in `tz` (falls back to UTC for an unknown zone). */
export function zonedParts(at: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; tz: string } {
  let zone = tz || 'UTC';
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    zone = 'UTC';
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second), tz: zone };
}

/** Offset (ms) of `tz` from UTC at `at`. */
function offsetMs(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a local wall-clock time happens in `tz` (DST-safe to within the hour change). */
function fromLocal(y: number, mo: number, d: number, minutes: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60, 0);
  const first = new Date(guess - offsetMs(new Date(guess), tz));
  return new Date(guess - offsetMs(first, tz));
}

export function inQuietHours(at: Date, w: QuietWindow | null, tz: string): boolean {
  return quietEnd(at, w, tz).getTime() !== at.getTime();
}

/** When the window covers `at`, the moment it ends; otherwise `at` itself. */
export function quietEnd(at: Date, w: QuietWindow | null, tz: string): Date {
  if (!w) return at;
  const qs = minutesOf(w.start);
  const qe = minutesOf(w.end);
  if (qs === null || qe === null || qs === qe) return at;
  const p = zonedParts(at, tz);
  const now = p.h * 60 + p.mi + p.s / 60;
  if (qs < qe) {
    if (now >= qs && now < qe) return fromLocal(p.y, p.mo, p.d, qe, p.tz);
    return at;
  }
  if (now >= qs) {
    const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    return fromLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), qe, p.tz);
  }
  if (now < qe) return fromLocal(p.y, p.mo, p.d, qe, p.tz);
  return at;
}

/** "22:00:00" → "10:00 p.m." */
export function clockLabel(t: string | null): string {
  if (!t) return '';
  const m = minutesOf(t);
  if (m === null) return t;
  const h = Math.floor(m / 60);
  const mi = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}
