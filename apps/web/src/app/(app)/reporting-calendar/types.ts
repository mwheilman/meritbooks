/** Client-side shapes for /reporting-calendar (type-only re-exports of the server read model). */
export type { CalendarResponse, RestatementLogEntry, PeriodDetail } from '@/lib/reports/governance/calendar-service';
export type { CalendarCell, CalendarRow, CellState } from '@/lib/reports/governance/calendar';
export type { FreshnessCard } from '@/lib/reports/governance/freshness';
export type { DeadlineTile } from '@/lib/reports/governance/deadlines';
export type { DeadlineDef, ReleaseSettings } from '@/lib/reports/governance/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 2026" from 'YYYY-MM'. */
export function monthName(key: string | null | undefined): string {
  if (!key) return '—';
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "Aug" from 'YYYY-MM'. */
export function monthShort(key: string): string {
  return MONTHS[Number(key.slice(5, 7)) - 1];
}

/** "Oct 3, 2026" from an ISO date / timestamp. */
export function dayName(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "3 days ago" / "today" from an ISO timestamp, against an ISO today. */
export function ago(iso: string | null | undefined, today: string): string {
  if (!iso) return 'never';
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
