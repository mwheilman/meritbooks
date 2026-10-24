/**
 * Viewer state ⇄ URL ⇄ ReportRequest (pure). Every choice the reader makes lives in the
 * URL, so a statement is shareable, bookmarkable and reload-safe; saved views store the
 * same state object.
 */
import type { Basis, ColumnMode, CompareKind, LayoutRef, PeriodPreset, ReportRequest, Rounding } from '@/lib/reports/engine/types';
import { findEngineReport } from './catalog';

export interface ViewState {
  report: string;
  preset: PeriodPreset;
  asOf: string;
  start?: string;
  end?: string;
  columns: ColumnMode;
  columnCount?: number;
  compare: CompareKind[];
  basis: Basis;
  customBasisLabel?: string | null;
  rounding: Rounding;
  companies: string[];
  consolidate: boolean;
  commonSize: boolean;
  showZero: boolean;
  ttm: boolean;
  layout: LayoutRef;
  tbMode: 'worksheet' | 'simple';
  departmentIds: string[];
  classIds: string[];
}

const PRESETS: PeriodPreset[] = ['month', 'quarter', 'year', 'mtd', 'qtd', 'ytd', 'ttm', 'custom'];
const COLS: ColumnMode[] = ['single', 'month', 'quarter', 'year', 'company', 'department', 'class', 'job', 'location'];
const CMPS: CompareKind[] = ['prior_period', 'prior_year', 'budget', 'forecast'];
const BASES: Basis[] = ['ACCRUAL', 'CASH', 'TAX', 'CUSTOM'];
const ROUNDS: Rounding[] = ['cents', 'units', 'thousands', 'millions'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The last day of the month before `today` — statements default to the last closed-ish month. */
export function lastMonthEnd(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}

export function defaultsFor(reportKey: string, today: string, activeCompanyId: string | null): ViewState {
  const def = findEngineReport(reportKey);
  const p = def?.preset;
  const preset = p?.period?.preset ?? (p?.statement === 'balance_sheet' || p?.statement === 'trial_balance' ? 'month' : 'ytd');
  const asOf = preset === 'ytd' || preset === 'mtd' || preset === 'qtd' ? today : lastMonthEnd(today);
  return {
    report: def?.key ?? 'pnl',
    preset,
    asOf,
    columns: p?.columns ?? 'single',
    columnCount: p?.columnCount,
    compare: p?.compare ?? [],
    basis: 'ACCRUAL',
    rounding: 'units',
    companies: activeCompanyId && !p?.consolidate && p?.columns !== 'company' ? [activeCompanyId] : [],
    consolidate: !!p?.consolidate,
    commonSize: !!p?.commonSize,
    showZero: false,
    ttm: !!p?.ttmColumn,
    layout: p?.layout ?? { kind: 'standard' },
    tbMode: p?.tbMode ?? 'worksheet',
    departmentIds: [],
    classIds: [],
  };
}

export function toRequest(s: ViewState): ReportRequest {
  const def = findEngineReport(s.report);
  const p = def?.preset;
  return {
    statement: p?.statement ?? 'income_statement',
    scope: { companyIds: s.companies, consolidate: s.consolidate || undefined },
    period: { preset: s.preset, asOf: s.asOf, start: s.preset === 'custom' ? s.start : undefined, end: s.preset === 'custom' ? s.end : undefined },
    columns: s.columns,
    columnCount: s.columnCount,
    ttmColumn: s.columns === 'month' ? s.ttm : undefined,
    compare: s.compare,
    variance: p?.variance,
    basis: s.basis,
    customBasisLabel: s.basis === 'CUSTOM' ? s.customBasisLabel ?? null : undefined,
    rounding: s.rounding,
    commonSize: s.commonSize || undefined,
    showZeroRows: s.showZero || undefined,
    layout: s.layout,
    tbMode: s.tbMode,
    filters: s.departmentIds.length || s.classIds.length ? { departmentIds: s.departmentIds.length ? s.departmentIds : undefined, classIds: s.classIds.length ? s.classIds : undefined } : undefined,
  };
}

export function toQuery(s: ViewState): URLSearchParams {
  const q = new URLSearchParams();
  q.set('report', s.report);
  q.set('p', s.preset);
  q.set('asof', s.asOf);
  if (s.preset === 'custom') {
    if (s.start) q.set('start', s.start);
    if (s.end) q.set('end', s.end);
  }
  q.set('cols', s.columns);
  if (s.columnCount) q.set('n', String(s.columnCount));
  if (s.compare.length) q.set('cmp', s.compare.join(','));
  if (s.basis !== 'ACCRUAL') q.set('basis', s.basis);
  if (s.customBasisLabel) q.set('bl', s.customBasisLabel);
  q.set('r', s.rounding);
  if (s.companies.length) q.set('co', s.companies.join(','));
  if (s.consolidate) q.set('consol', '1');
  if (s.commonSize) q.set('cs', '1');
  if (s.showZero) q.set('zero', '1');
  if (s.ttm) q.set('ttm', '1');
  if (s.layout.kind === 'ebitda') q.set('layout', 'ebitda');
  if (s.layout.kind === 'custom') q.set('layout', s.layout.layoutId);
  if (s.tbMode === 'simple') q.set('tb', 'simple');
  if (s.departmentIds.length) q.set('dept', s.departmentIds.join(','));
  if (s.classIds.length) q.set('cls', s.classIds.join(','));
  return q;
}

const list = <T extends string>(raw: string | null, allowed: readonly T[]): T[] =>
  (raw ?? '').split(',').filter((x): x is T => (allowed as readonly string[]).includes(x));
const ids = (raw: string | null): string[] => (raw ?? '').split(',').filter((x) => UUID.test(x)).slice(0, 200);

/** Parse a URL into state. Anything missing or malformed falls back to the report's defaults. */
export function fromQuery(q: URLSearchParams, today: string, activeCompanyId: string | null): ViewState {
  const d = defaultsFor(q.get('report') ?? 'pnl', today, activeCompanyId);
  if (!q.has('p')) return d; // a bare legacy link (?report=pnl) → that report's defaults
  const preset = (PRESETS as string[]).includes(q.get('p') ?? '') ? (q.get('p') as PeriodPreset) : d.preset;
  const layoutRaw = q.get('layout');
  return {
    ...d,
    preset,
    asOf: ISO.test(q.get('asof') ?? '') ? (q.get('asof') as string) : d.asOf,
    start: ISO.test(q.get('start') ?? '') ? (q.get('start') as string) : undefined,
    end: ISO.test(q.get('end') ?? '') ? (q.get('end') as string) : undefined,
    columns: (COLS as string[]).includes(q.get('cols') ?? '') ? (q.get('cols') as ColumnMode) : d.columns,
    columnCount: Number(q.get('n')) > 0 ? Math.min(60, Number(q.get('n'))) : d.columnCount,
    compare: q.has('cmp') ? list(q.get('cmp'), CMPS) : [],
    basis: (BASES as string[]).includes(q.get('basis') ?? '') ? (q.get('basis') as Basis) : 'ACCRUAL',
    customBasisLabel: q.get('bl'),
    rounding: (ROUNDS as string[]).includes(q.get('r') ?? '') ? (q.get('r') as Rounding) : d.rounding,
    companies: ids(q.get('co')),
    consolidate: q.get('consol') === '1',
    commonSize: q.get('cs') === '1',
    showZero: q.get('zero') === '1',
    ttm: q.get('ttm') === '1',
    layout: layoutRaw === 'ebitda' ? { kind: 'ebitda' } : layoutRaw && UUID.test(layoutRaw) ? { kind: 'custom', layoutId: layoutRaw } : d.layout,
    tbMode: q.get('tb') === 'simple' ? 'simple' : 'worksheet',
    departmentIds: ids(q.get('dept')),
    classIds: ids(q.get('cls')),
  };
}

/** Pack spec mapping (compiler grammar) for "Add to a report pack"; null when unsupported. */
export function toPackSpec(s: ViewState): { report: string; basis: 'ACCRUAL' | 'CASH'; periods: Array<Record<string, unknown>> } | null {
  const st = findEngineReport(s.report)?.preset?.statement;
  const report = st === 'income_statement' ? 'INCOME_STATEMENT' : st === 'balance_sheet' ? 'BALANCE_SHEET' : st === 'trial_balance' ? 'TRIAL_BALANCE' : st === 'cash_flow' ? 'CASH_FLOW' : null;
  if (!report) return null;
  const period =
    s.preset === 'ytd' ? { type: 'FISCAL_YTD' }
    : s.preset === 'year' ? { type: 'FISCAL_YEAR', offset: 0 }
    : s.preset === 'quarter' ? { type: 'LAST_N_MONTHS', n: 3 }
    : s.preset === 'ttm' ? { type: 'LAST_N_MONTHS', n: 12 }
    : s.preset === 'custom' && s.start && s.end ? { type: 'EXPLICIT', startDate: s.start, endDate: s.end }
    : { type: 'LAST_N_MONTHS', n: 1 };
  return { report, basis: s.basis === 'CASH' ? 'CASH' : 'ACCRUAL', periods: [period] };
}
