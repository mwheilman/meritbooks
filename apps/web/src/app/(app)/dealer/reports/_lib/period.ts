/**
 * Period presets for the dealer reports page (local calendar dates). Pure.
 */

export type PeriodKey = 'this_month' | 'last_month' | 'this_quarter' | 'ytd' | 'last_year' | 'custom';

export const PERIOD_OPTIONS: Array<{ value: PeriodKey; label: string }> = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last_year', label: 'Last year' },
  { value: 'custom', label: 'Custom' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function localToday(now: Date = new Date()): string {
  return iso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function presetRange(key: Exclude<PeriodKey, 'custom'>, now: Date = new Date()): { start: string; end: string } {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  switch (key) {
    case 'this_month':
      return { start: iso(y, m, 1), end: iso(y, m, lastDay(y, m)) };
    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { start: iso(py, pm, 1), end: iso(py, pm, lastDay(py, pm)) };
    }
    case 'this_quarter': {
      const qs = Math.floor((m - 1) / 3) * 3 + 1;
      return { start: iso(y, qs, 1), end: iso(y, qs + 2, lastDay(y, qs + 2)) };
    }
    case 'ytd':
      return { start: iso(y, 1, 1), end: localToday(now) };
    case 'last_year':
      return { start: iso(y - 1, 1, 1), end: iso(y - 1, 12, 31) };
  }
}

export function isIsoDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
