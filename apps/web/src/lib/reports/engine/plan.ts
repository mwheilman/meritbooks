/**
 * Column planner (pure). Turns a ReportRequest into the concrete column list (amount,
 * comparison, variance, common-size, total, eliminations, consolidated) and the exact set
 * of balance ranges the adapter must load. The builder then fills the columns.
 */
import {
  addDays,
  buckets,
  fiscalYearStart,
  isMonthAligned,
  monthStart,
  addMonths,
  monthEnd,
  priorPeriod,
  priorYear,
  rangeKey,
  rangeLabel,
  resolvePeriod,
  shortDate,
} from './periods';
import { ALL_KINDS, PNL_KINDS, monthSlices, type CellSpec } from './aggregate';
import type {
  ColumnKind,
  ColumnSource,
  CompanyMeta,
  CompareKind,
  DateRange,
  DimensionKey,
  DimensionMeta,
  ReportColumn,
  ReportRequest,
  StatementKind,
} from './types';

export type ColumnRole = 'base' | 'total' | 'ttm' | 'compare' | 'variance_amount' | 'variance_pct' | 'common_size' | 'combined' | 'elimination' | 'consolidated';

export interface PlannedColumn extends ReportColumn {
  role: ColumnRole;
  /** amount columns: how to compute the account map */
  cell?: CellSpec;
  /** the activity window behind a point-in-time column (its comparisons shift this window) */
  window?: DateRange;
  compareKind?: CompareKind;
}

export interface FetchPlan {
  /** main store read: month buckets from..to plus one opening bucket before `from` */
  from: string;
  to: string;
  dims: Array<DimensionKey | 'counterparty'>;
  /** ranges that cut a month: loaded exactly */
  exactRanges: DateRange[];
  needsBudget: boolean;
  /** P&L ranges per company set that need live CASH-basis deltas */
  cashBasisCells: Array<{ range: DateRange; companyIds: string[] }>;
}

export interface Plan {
  statement: StatementKind;
  range: DateRange;
  fyStartMonth: number;
  columns: PlannedColumn[];
  fetch: FetchPlan;
  pointInTime: boolean;
  companyIds: string[];
  consolidated: boolean;
  dimension: DimensionKey | null;
}

export interface PlanContext {
  companies: CompanyMeta[];
  /** in-scope companies for this request (already client-scope validated) */
  companyIds: string[];
  orgFiscalYearStartMonth: number;
  dimensions: Partial<Record<DimensionKey, DimensionMeta[]>>;
}

const COMPARE_LABEL: Record<CompareKind, string> = {
  prior_period: 'Prior period',
  prior_year: 'Prior year',
  budget: 'Budget',
  forecast: 'Forecast',
};

export function fyStartFor(ctx: Pick<PlanContext, 'companies' | 'companyIds' | 'orgFiscalYearStartMonth'>): number {
  if (ctx.companyIds.length === 1) {
    const c = ctx.companies.find((x) => x.id === ctx.companyIds[0]);
    if (c) return c.fiscalYearStartMonth;
  }
  return ctx.orgFiscalYearStartMonth;
}

function isPointInTime(s: StatementKind): boolean {
  return s === 'balance_sheet' || s === 'trial_balance';
}

export function planReport(req: ReportRequest, ctx: PlanContext): Plan {
  const fy = fyStartFor(ctx);
  const main = resolvePeriod(req.period, fy);
  const statement = req.statement;
  const pit = isPointInTime(statement);
  const pnlKinds = statement === 'income_statement' ? PNL_KINDS : ALL_KINDS;
  const kinds = pit ? ALL_KINDS : pnlKinds;
  const companyIds = ctx.companyIds;
  const asCol = (r: DateRange): DateRange => (pit ? { start: null, end: r.end } : r);
  const mode = req.columns === 'location' ? 'company' : req.columns;
  // statements with a fixed column structure
  const fixed = statement === 'equity_changes' || statement === 'trial_balance' || statement === 'gl_summary';
  const effectiveMode = fixed ? 'single' : mode;
  const consolidated = !!req.scope.consolidate && companyIds.length > 1;
  const dimension: DimensionKey | null =
    effectiveMode === 'department' || effectiveMode === 'class' || effectiveMode === 'job' ? effectiveMode : null;

  const cols: PlannedColumn[] = [];
  const amountCol = (
    id: string,
    label: string,
    role: ColumnRole,
    cell: CellSpec,
    source: ColumnSource = 'actual',
    extra: Partial<PlannedColumn> = {},
  ): PlannedColumn => ({
    id,
    label,
    kind: (role === 'total' || role === 'combined' || role === 'consolidated' ? 'total' : role === 'elimination' ? 'elimination' : 'amount') as ColumnKind,
    source,
    range: cell.range,
    role,
    cell,
    drill: source === 'actual' && role !== 'elimination' && role !== 'consolidated'
      ? { companyIds: cell.companyIds, range: cell.range, dims: cell.dim ? { [cell.dim.key]: cell.dim.value } : undefined, kinds: cell.kinds }
      : null,
    ...extra,
  });

  // ── base columns ──
  const base: PlannedColumn[] = [];
  if (effectiveMode === 'single') {
    base.push(amountCol('cur', pit ? `As of ${shortDate(main.end)}` : rangeLabel(main), 'base', { range: asCol(main), companyIds, kinds }, 'actual', { current: true, window: main }));
  } else if (effectiveMode === 'month' || effectiveMode === 'quarter' || effectiveMode === 'year') {
    const bs = buckets(effectiveMode, { start: main.start ?? main.end, end: main.end }, fy, req.columnCount);
    bs.forEach((b, i) =>
      base.push(amountCol(`b${i}`, b.label, 'base', { range: asCol(b.range), companyIds, kinds }, 'actual', { sublabel: b.sublabel, current: i === bs.length - 1, window: b.range })),
    );
  } else if (effectiveMode === 'company') {
    const ordered = ctx.companies.filter((c) => companyIds.includes(c.id)).sort((a, b) => a.name.localeCompare(b.name));
    for (const c of ordered) base.push(amountCol(`co:${c.id}`, c.shortCode || c.name, 'base', { range: asCol(main), companyIds: [c.id], kinds }, 'actual', { sublabel: c.shortCode ? c.name : undefined }));
  } else if (dimension) {
    const values = ctx.dimensions[dimension] ?? [];
    for (const d of values) base.push(amountCol(`dim:${d.id}`, d.name, 'base', { range: asCol(main), companyIds, kinds, dim: { key: dimension, value: d.id } }));
    base.push(amountCol('dim:none', 'Unassigned', 'base', { range: asCol(main), companyIds, kinds, dim: { key: dimension, value: null } }));
  }
  cols.push(...base);

  // ── totals ──
  const totals: PlannedColumn[] = [];
  const timeSplit = effectiveMode === 'month' || effectiveMode === 'quarter' || effectiveMode === 'year';
  const wantTotal = req.totalColumn !== false && base.length > 1 && !(pit && timeSplit);
  if (effectiveMode === 'company' && consolidated) {
    totals.push(amountCol('combined', 'Combined', 'combined', { range: asCol(main), companyIds, kinds }));
    totals.push(amountCol('elim', 'Eliminations', 'elimination', { range: asCol(main), companyIds, kinds }));
    totals.push(amountCol('consol', 'Consolidated', 'consolidated', { range: asCol(main), companyIds, kinds }, 'actual', { current: true }));
  } else if (wantTotal) {
    const totalRange = timeSplit ? { start: base[0].range.start, end: base[base.length - 1].range.end } : asCol(main);
    totals.push(amountCol('total', 'Total', 'total', { range: totalRange, companyIds, kinds }, 'actual', { current: effectiveMode !== 'month' }));
  }
  if (req.ttmColumn && effectiveMode === 'month' && !pit) {
    const end = base[base.length - 1]?.range.end ?? main.end;
    const ttm: DateRange = { start: addMonths(monthStart(end), -11), end };
    // Twelve monthly columns ending in the TTM month already make the Total the TTM — a second,
    // identical column would only invite "why are these the same?". Say so on the Total instead.
    const total = totals.find((t) => t.role === 'total');
    if (total && total.range.start === ttm.start && total.range.end === ttm.end) total.sublabel = 'Trailing 12 months';
    else totals.push(amountCol('ttm', 'TTM', 'ttm', { range: ttm, companyIds, kinds }, 'actual', { sublabel: 'Trailing 12 months' }));
  }
  cols.push(...totals);

  // ── comparisons ──
  const compareEach = req.compareEach ?? base.length === 1;
  const targets = compareEach ? [...base, ...totals.filter((t) => t.role !== 'elimination')] : totals.length ? [totals.find((t) => t.role === 'consolidated') ?? totals[0]] : base.slice(-1);
  const compares = fixed ? [] : req.compare;
  const variance = req.variance !== false;
  const out: PlannedColumn[] = [];
  for (const c of cols) {
    out.push(c);
    if (!targets.includes(c)) continue;
    for (const k of compares) {
      const cell = compareCell(k, c.cell!, pit, c.window ?? main);
      if (!cell) continue;
      const src: ColumnSource = k === 'budget' ? 'budget' : k === 'forecast' ? 'forecast' : 'actual';
      const cmp = amountCol(`${c.id}~${k}`, COMPARE_LABEL[k], 'compare', cell, src, {
        sublabel: k === 'budget' || k === 'forecast' ? undefined : rangeLabel(cell.range),
        compareKind: k,
      });
      out.push(cmp);
      if (variance) {
        out.push({ id: `${c.id}~${k}~d`, label: '$ Var', kind: 'variance_amount', source: 'actual', range: c.range, role: 'variance_amount', of: c.id, against: cmp.id, compareKind: k });
        out.push({ id: `${c.id}~${k}~p`, label: '% Var', kind: 'variance_pct', source: 'actual', range: c.range, role: 'variance_pct', of: c.id, against: cmp.id, percent: true, compareKind: k });
      }
    }
  }

  // ── common size ──
  let final = out;
  if (req.commonSize && (statement === 'income_statement' || statement === 'balance_sheet')) {
    final = [];
    for (const c of out) {
      final.push(c);
      if (c.cell && c.role !== 'elimination') {
        final.push({ id: `${c.id}~cs`, label: statement === 'income_statement' ? '% of rev' : '% of assets', kind: 'common_size', source: c.source, range: c.range, role: 'common_size', of: c.id, percent: true });
      }
    }
  }

  // ── fetch plan ──
  const ranges: DateRange[] = [];
  const cashBasisCells: Array<{ range: DateRange; companyIds: string[] }> = [];
  const splitStarts: string[] = [];
  for (const c of final) {
    if (!c.cell) continue;
    const r = c.cell.range;
    if (c.source === 'budget') continue;
    if (c.source === 'forecast' && r.start) {
      for (const s of monthSlices({ start: r.start, end: r.end })) ranges.push(s);
      continue;
    }
    ranges.push(r);
    if (pit || statement === 'trial_balance') splitStarts.push(fiscalYearStart(r.end, fy));
    if (statement === 'cash_flow' || statement === 'equity_changes' || statement === 'gl_summary') {
      if (r.start) {
        ranges.push({ start: null, end: addDays(r.start, -1) });
        ranges.push({ start: null, end: r.end });
        if (statement === 'gl_summary') splitStarts.push(fiscalYearStart(r.start, fy));
      }
    }
    if (statement === 'trial_balance') {
      ranges.push(main);
      ranges.push({ start: fiscalYearStart(r.end, fy), end: r.end });
    }
    if (statement === 'gl_summary' && r.start) {
      const f = fiscalYearStart(r.start, fy);
      if (f < r.start) ranges.push({ start: f, end: addDays(r.start, -1) });
    }
    if (req.basis === 'CASH' && !pit && r.start) cashBasisCells.push({ range: r, companyIds: c.cell.companyIds });
  }
  const starts = [...ranges.map((r) => r.start).filter((s): s is string => !!s), ...splitStarts].map(monthStart);
  const ends = ranges.map((r) => r.end);
  const from = starts.length ? starts.sort()[0] : monthStart(main.end);
  const to = ends.length ? monthEnd(ends.sort()[ends.length - 1]) : monthEnd(main.end);
  const seen = new Set<string>();
  const exactRanges = ranges.filter((r) => {
    if (isMonthAligned(r)) return false;
    const k = rangeKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const dims = new Set<DimensionKey | 'counterparty'>();
  if (dimension) dims.add(dimension);
  if (req.filters?.departmentIds?.length) dims.add('department');
  if (req.filters?.classIds?.length) dims.add('class');
  if (req.filters?.jobIds?.length) dims.add('job');
  if (req.filters?.itemIds?.length) dims.add('item');
  if (consolidated) dims.add('counterparty');
  return {
    statement,
    range: pit ? { start: null, end: main.end } : main,
    fyStartMonth: fy,
    columns: final,
    fetch: {
      from,
      to,
      dims: [...dims],
      exactRanges,
      needsBudget: compares.includes('budget') || compares.includes('forecast'),
      cashBasisCells,
    },
    pointInTime: pit,
    companyIds,
    consolidated,
    dimension,
  };
}

function compareCell(k: CompareKind, cell: CellSpec, pit: boolean, window: DateRange): CellSpec | null {
  if (k === 'budget' || k === 'forecast') {
    if (pit) return null; // budgets are P&L flows
    return { ...cell };
  }
  if (pit) {
    // point-in-time: as of the end of the prior window (prior quarter end for a quarter, …)
    const w = window.start === null ? { start: monthStart(window.end), end: window.end } : window;
    const end = k === 'prior_period' ? priorPeriod(w).end : priorYear(w).end;
    return { ...cell, range: { start: null, end } };
  }
  return { ...cell, range: k === 'prior_period' ? priorPeriod(cell.range) : priorYear(cell.range) };
}
