/**
 * The PeriodPicker's interaction model (PURE, tested) — what a month click means under each
 * window, which months are selectable, how the ‹ › stepper moves, which presets a host can show.
 * The React component (components/period/period-picker.tsx) is only rendering + focus.
 */
import {
  addMonths,
  fiscalQuarterStart,
  fiscalYearMonths,
  fiscalYearOf,
  fiscalYearStart,
  maxMonth,
  minMonth,
  monthDiff,
  monthShort,
  normalizeFyStart,
  PERIOD_PRESETS,
  presetSelection,
  rangeName,
  windowBounds,
  type MonthKey,
  type PeriodBasis,
  type PeriodComparison,
  type PeriodContext,
  type PeriodSelection,
  type PresetDef,
} from './resolve';

export const BASIS_LABELS: Record<PeriodBasis, string> = {
  month: 'Month',
  qtd: 'QTD',
  quarter: 'Quarter',
  ytd: 'YTD',
  fy: 'Year',
  ttm: 'TTM',
  range: 'Range',
};

export const BASIS_DESCRIPTIONS: Record<PeriodBasis, string> = {
  month: 'One month',
  qtd: 'Quarter to date, ending in the month you pick',
  quarter: 'The whole fiscal quarter',
  ytd: 'Fiscal year to date, ending in the month you pick',
  fy: 'The whole fiscal year',
  ttm: 'Twelve months ending in the month you pick',
  range: 'Pick a first and a last month',
};

/** Window chips in display order, limited to what the host can compute. */
export function windowOptions(bases?: readonly PeriodBasis[]): PeriodBasis[] {
  const order: PeriodBasis[] = ['month', 'quarter', 'qtd', 'ytd', 'ttm', 'fy', 'range'];
  return bases ? order.filter((b) => bases.includes(b)) : order;
}

/** Presets the host can compute ("Custom range" only when ranges are allowed). */
export function presetOptions(bases?: readonly PeriodBasis[]): PresetDef[] {
  return PERIOD_PRESETS.filter((p) => !bases || bases.includes(p.basis));
}

export function comparisonOptions(comparisons?: readonly PeriodComparison[]): PeriodComparison[] {
  if (!comparisons || comparisons.length === 0) return [];
  const order: PeriodComparison[] = ['none', 'prior_period', 'prior_year', 'budget'];
  return order.filter((c) => c === 'none' || comparisons.includes(c));
}

/** Can the month be picked as the anchor of a `basis` window? */
export function isSelectable(month: MonthKey, basis: PeriodBasis, ctx: PeriodContext): boolean {
  const fy = normalizeFyStart(ctx.fyStartMonth);
  if (basis === 'quarter') return fiscalQuarterStart(month, fy) <= ctx.currentMonth;
  if (basis === 'fy') return fiscalYearStart(month, fy) <= ctx.currentMonth;
  return month <= ctx.currentMonth;
}

/** The selection a click on `month` makes (range: the second click, given the first). */
export function selectionForMonth(
  month: MonthKey,
  basis: PeriodBasis,
  compare: PeriodComparison | undefined,
  rangeAnchor?: MonthKey | null,
): PeriodSelection {
  const cmp = compare && compare !== 'none' ? { compare } : {};
  if (basis === 'range') {
    const a = rangeAnchor ?? month;
    return { basis, start: minMonth(a, month), end: maxMonth(a, month), preset: 'custom', ...cmp };
  }
  return { basis, end: month, ...cmp };
}

export type CellRole = 'end' | 'in' | 'out';

/** How a month cell reads against a window. */
export function cellRole(month: MonthKey, win: { start: MonthKey; end: MonthKey }): CellRole {
  if (month === win.end || month === win.start) return 'end';
  return month > win.start && month < win.end ? 'in' : 'out';
}

/** The 12 months shown for fiscal year `fiscalYear`. */
export function gridMonths(fiscalYear: number, fyStartMonth: number): MonthKey[] {
  return fiscalYearMonths(fiscalYear, fyStartMonth);
}

/** "Jan–Dec 2026" / "Jul 2026–Jun 2027" under the fiscal-year name. */
export function fiscalYearSpan(fiscalYear: number, fyStartMonth: number): string {
  const m = fiscalYearMonths(fiscalYear, fyStartMonth);
  return rangeName(m[0], m[11]);
}

/** Latest fiscal year the grid can show (the one containing today). */
export function maxFiscalYear(ctx: PeriodContext): number {
  return fiscalYearOf(ctx.currentMonth, ctx.fyStartMonth);
}

/** How far ‹ › moves a selection: its natural length (month 1, quarter 3, year 12, range its own). */
export function stepSize(sel: PeriodSelection, fyStartMonth: number): number {
  switch (sel.basis) {
    case 'quarter':
      return 3;
    case 'fy':
      return 12;
    case 'range': {
      const b = windowBounds(sel, fyStartMonth);
      return Math.max(1, monthDiff(b.start, b.end) + 1);
    }
    default:
      return 1;
  }
}

/** The selection one step earlier (dir −1) or later (+1); null when the step would pass today. */
export function stepSelection(sel: PeriodSelection, dir: -1 | 1, ctx: PeriodContext): PeriodSelection | null {
  const fy = normalizeFyStart(ctx.fyStartMonth);
  const n = stepSize(sel, fy) * dir;
  const b = windowBounds(sel, fy);
  const next: PeriodSelection =
    sel.basis === 'range'
      ? { basis: 'range', start: addMonths(b.start, n), end: addMonths(b.end, n), compare: sel.compare, preset: 'custom' }
      : { basis: sel.basis, end: addMonths(sel.basis === 'quarter' || sel.basis === 'fy' ? b.end : sel.end, n), compare: sel.compare };
  if (dir > 0) {
    const nb = windowBounds(next, fy);
    if (sel.basis === 'quarter' || sel.basis === 'fy') {
      if (nb.start > ctx.currentMonth) return null;
    } else if (nb.end > ctx.currentMonth) return null;
  }
  return next;
}

/** The window a hover/focus on `month` would select — the grid previews it before the click. */
export function previewWindow(month: MonthKey, basis: PeriodBasis, ctx: PeriodContext, rangeAnchor?: MonthKey | null): { start: MonthKey; end: MonthKey } {
  const fy = normalizeFyStart(ctx.fyStartMonth);
  if (basis === 'range') return { start: minMonth(rangeAnchor ?? month, month), end: maxMonth(rangeAnchor ?? month, month) };
  return windowBounds({ basis, end: month }, fy);
}

/** Today's meaning of every preset, for the right-hand meta ("Jan–Oct 2026", "Nov ’25–Oct ’26"). */
export function presetMeta(id: PresetDef['id'], ctx: PeriodContext): string {
  const s = presetSelection(id, ctx);
  const b = windowBounds(s, ctx.fyStartMonth);
  if (b.start.slice(0, 4) === b.end.slice(0, 4)) return rangeName(b.start, b.end);
  const short = (k: MonthKey) => `${monthShort(k)} ’${k.slice(2, 4)}`;
  return `${short(b.start)}–${short(b.end)}`;
}
