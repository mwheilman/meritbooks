/**
 * Date text as people type it in a grid cell: "2026-11-18", "11/18", "11/18/26", "Nov 18",
 * "18 Nov 2026". A year-less date takes the year that puts it nearest `today`. Pure.
 */
import { dayNum } from './calendar';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // Feb 30
  return dt.toISOString().slice(0, 10);
}

function nearestYear(m: number, d: number, today: string): string | null {
  const y = Number(today.slice(0, 4));
  const options = [y - 1, y, y + 1].map((yy) => iso(yy, m, d)).filter((x): x is string => !!x);
  if (!options.length) return null;
  const t = dayNum(today);
  return options.reduce((best, x) => (Math.abs(dayNum(x) - t) < Math.abs(dayNum(best) - t) ? x : best));
}

export function parseDayInput(text: string, today: string): string | null {
  const s = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (!m[3]) return nearestYear(mo, d, today);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, mo, d);
  }
  m = /^([a-z]{3,9})\.? (\d{1,2})(?: (\d{4}))?$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3)) + 1;
    if (!mo) return null;
    return m[3] ? iso(Number(m[3]), mo, Number(m[2])) : nearestYear(mo, Number(m[2]), today);
  }
  m = /^(\d{1,2}) ([a-z]{3,9})\.?(?: (\d{4}))?$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.slice(0, 3)) + 1;
    if (!mo) return null;
    return m[3] ? iso(Number(m[3]), mo, Number(m[1])) : nearestYear(mo, Number(m[1]), today);
  }
  if (s === 'today') return today;
  return null;
}

/** "3d", "3", "2w" → working days (a week is 5). */
export function parseDurationInput(text: string): number | null {
  const m = /^\s*(\d{1,4})\s*(d|days?|w|wks?|weeks?)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] && /^w/i.test(m[2]) ? 5 : 1);
  return n <= 3650 ? n : null;
}

/** "40", "40%", "0.4" → 0.4 */
export function parsePctInput(text: string): number | null {
  const s = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  const v = n <= 1 && s.includes('.') ? n : n / 100;
  return v >= 0 && v <= 1 ? Math.round(v * 10_000) / 10_000 : null;
}
