/**
 * Presentation rounding (pure). The engine always carries exact integer cents; rounding
 * happens ONLY here, once per displayed figure, from exact cents. Totals are therefore
 * computed before rounding and never accumulate drift — a displayed column may differ
 * from the sum of its displayed (rounded) rows by at most half a unit per row, which the
 * viewer footnotes ("Rounded; totals computed before rounding"). Exports carry full cents.
 */
import { formatRatio } from '@/lib/format/ratio';
import type { ReportColumn, ReportRow, Rounding } from './types';

export const ROUNDING_UNIT_LABEL: Record<Rounding, string> = {
  cents: 'In US dollars',
  units: 'In US dollars (whole)',
  thousands: 'In thousands of US dollars ($K)',
  millions: 'In millions of US dollars ($M)',
};

const DIVISOR: Record<Rounding, number> = { cents: 100, units: 100, thousands: 100_000, millions: 100_000_000 };
const DECIMALS: Record<Rounding, number> = { cents: 2, units: 0, thousands: 1, millions: 2 };

/** Scaled value as a number (for charts / CSV in the chosen unit). Rounds half away from zero. */
export function scaleCents(cents: number, rounding: Rounding): number {
  const d = DECIMALS[rounding];
  const f = 10 ** d;
  const v = cents / DIVISOR[rounding];
  return (Math.sign(v) * Math.round(Math.abs(v) * f)) / f;
}

/** Accounting format: parentheses for negatives, '–' for exact zero, '0' for a non-zero that rounds to zero. */
export function formatAmount(cents: number | null | undefined, rounding: Rounding): string {
  if (cents == null) return '';
  if (cents === 0) return '–';
  const v = scaleCents(cents, rounding);
  const d = DECIMALS[rounding];
  if (v === 0) return '0';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return v < 0 ? `(${s})` : s;
}

export function formatPercent(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '';
  const s = Math.abs(p).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return p < 0 ? `(${s}%)` : `${s}%`;
}

/** Points (margin variances compare in points, not %). */
export function formatPoints(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '';
  const s = Math.abs(p).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return p < 0 ? `(${s} pts)` : `${s} pts`;
}

/** A row whose values are not cents (percent or ratio formula rows). */
export function isNonMoneyRow(r: Pick<ReportRow, 'percent' | 'ratio'>): boolean {
  return !!(r.percent || r.ratio);
}

/** A column whose values are percents (not cents). */
export function isPercentColumn(c: Pick<ReportColumn, 'percent' | 'kind'>): boolean {
  return !!(c.percent || c.kind === 'variance_pct' || c.kind === 'common_size');
}

/** THE cell text for a statement cell — the on-screen grid and the PDF / export model share it. */
export function formatCell(r: Pick<ReportRow, 'percent' | 'ratio'>, c: Pick<ReportColumn, 'percent' | 'kind'>, v: number | null | undefined, rounding: Rounding): string {
  if (v == null) return '';
  if (isPercentColumn(c)) return formatPercent(v);
  if (r.ratio) return formatRatio(v, { delta: c.kind === 'variance_amount', empty: '' });
  if (r.percent) return c.kind === 'variance_amount' ? formatPoints(v) : formatPercent(v);
  return formatAmount(v, rounding);
}
