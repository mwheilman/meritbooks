/**
 * Display helpers for the department-budget workspace (Wave 4B). Pure; no React.
 */
import type { BridgeStep as ChartBridgeStep } from '@/components/charts';
import type { BoardStatus, BridgeOut, VersionStatus } from '@/lib/budgets/types';

export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Tag tone for a version status. */
export function versionTone(s: VersionStatus): 'default' | 'pos' | 'warn' | 'solid' | 'neg' {
  switch (s) {
    case 'DRAFT': return 'default';
    case 'IN_REVIEW': return 'warn';
    case 'APPROVED': return 'pos';
    case 'LOCKED': return 'solid';
    case 'SUPERSEDED': return 'neg';
  }
}

/** Status pip kind for a department plan; null = no department review in this version (plain text, no pip). */
export function planKind(s: BoardStatus, overdue: boolean): 'ready' | 'track' | 'risk' | 'overdue' | 'blocked' | null {
  if (s === 'APPROVED') return 'ready';
  if (s === 'NOT_IN_VERSION' || s === 'NO_REVIEW') return null;
  if (overdue) return 'overdue';
  if (s === 'RETURNED') return 'risk';
  if (s === 'SUBMITTED') return 'track';
  return 'blocked';
}

export function pctText(frac: number | null, digits = 1): string {
  if (frac === null || !Number.isFinite(frac)) return '—';
  const v = frac * 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`;
}

export function bpsToPctText(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Cents → plain dollars text for an editable cell ("1234.5"). */
export function centsToInput(cents: number): string {
  if (cents === 0) return '';
  const neg = cents < 0;
  const a = Math.abs(cents);
  const d = Math.floor(a / 100);
  const c = a % 100;
  return `${neg ? '-' : ''}${d}${c ? `.${String(c).padStart(2, '0').replace(/0$/, '')}` : ''}`;
}

/** Whole-dollar display for grid cells (cents kept underneath). */
export function gridMoney(cents: number): string {
  if (cents === 0) return '–';
  const neg = cents < 0;
  const s = Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
  return neg ? `(${s})` : s;
}

export function isIncomeType(type: string, subType?: string): boolean {
  return type === 'REVENUE' || (type === 'OTHER' && subType === 'OTHER_INCOME');
}

export const SECTION_OF_TYPE: Record<string, 'revenue' | 'cogs' | 'opex' | 'other'> = { REVENUE: 'revenue', COGS: 'cogs', OPEX: 'opex', OTHER: 'other' };
export const SECTION_LABEL: Record<'revenue' | 'cogs' | 'opex' | 'other', string> = {
  revenue: 'Revenue',
  cogs: 'Cost of revenue',
  opex: 'Operating expenses',
  other: 'Other income & expense',
};

/** BridgeOut (lib/budgets/bridges) → the chart kit's start / delta / end steps. */
export function toChartSteps(b: BridgeOut): ChartBridgeStep[] {
  return [
    { key: 'start', label: b.start.label, kind: 'start', value: b.start.cents },
    ...b.steps.map((s): ChartBridgeStep => ({ key: s.key, label: s.label, kind: 'delta', value: s.cents, direction: b.direction })),
    { key: 'end', label: b.end.label, kind: 'end', value: b.end.cents },
  ];
}

/** start + Σ steps = end (printed under every bridge). */
export function bridgeTieCaption(b: BridgeOut): string {
  const sum = b.steps.reduce((t, s) => t + s.cents, 0);
  return b.start.cents + sum === b.end.cents ? 'Steps sum to end − start, to the cent.' : 'Steps do not tie to end − start.';
}

export function monthOptions(): Array<{ value: number; label: string }> {
  return MONTH_LABELS.map((label, i) => ({ value: i + 1, label }));
}

/** The default month for a department view: last closed-ish month of the year. */
/**
 * The last month a "Through" picker may offer for a fiscal year (calendar-year budgets): a past
 * year → 12, the current year → this month, a year that hasn't started → 0 (nothing selectable).
 */
export function maxThroughMonth(fiscalYear: number, today = new Date()): number {
  const y = today.getFullYear();
  if (fiscalYear < y) return 12;
  if (fiscalYear > y) return 0;
  return today.getMonth() + 1;
}

/**
 * The month a budget-vs-actual view opens "through" — never in the future:
 *  - a year that hasn't started → null (there are no actuals; the view says so);
 *  - the current year → the last full month (January: January), pulled back to the latest
 *    month that has actuals when the books stop earlier;
 *  - a past year → the latest month with actuals, else December.
 * `latestActualMonth` is 1–12 within the fiscal year, or null when unknown / none.
 */
export function defaultMonth(fiscalYear: number, today = new Date(), latestActualMonth: number | null = null): number | null {
  const max = maxThroughMonth(fiscalYear, today);
  if (max === 0) return null;
  const actual = latestActualMonth !== null && latestActualMonth >= 1 && latestActualMonth <= 12 ? latestActualMonth : null;
  if (fiscalYear < today.getFullYear()) return actual ?? 12;
  const lastFull = Math.max(1, max - 1);
  return actual !== null ? Math.min(lastFull, actual) : lastFull;
}

export function fiscalYears(today = new Date()): number[] {
  const y = today.getFullYear();
  return [y + 1, y, y - 1, y - 2];
}

export function errText(e: { error?: string } | string | null | undefined, fallback = 'Something went wrong.'): string {
  if (!e) return fallback;
  return typeof e === 'string' ? e : e.error ?? fallback;
}
