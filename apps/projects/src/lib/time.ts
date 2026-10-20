/**
 * Calendar "today" and timestamps for the people using the app (not the server's
 * UTC day). NEXT_PUBLIC_APP_TIME_ZONE overrides (public, so server and browser
 * render the same text); the default is US Central, where the first tenant works.
 */
import { isoWeek } from '@meritbooks/merit-ui';

export const APP_TZ = process.env.NEXT_PUBLIC_APP_TIME_ZONE || 'America/Chicago';
const TZ = APP_TZ;

/** "2026-10-20" in the app time zone. */
export function todayIso(now: Date = new Date(), timeZone: string = TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** ISO date `days` after `iso`. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function weekLabel(iso: string): string {
  return `Week ${isoWeek(iso)}`;
}

/** "Oct 20 · 9:41 AM" for a timestamp, in the app time zone (same text on server and browser). */
export function stamp(iso: string, timeZone: string = TZ): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')} ${get('day')} · ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

/** The calendar day of a timestamp in the app time zone ("2026-10-20"). */
export function dayOf(iso: string, timeZone: string = TZ): string {
  return todayIso(new Date(iso), timeZone);
}
