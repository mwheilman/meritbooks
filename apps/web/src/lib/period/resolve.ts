/**
 * The ONE period resolver behind every period picker in Books (PURE — no I/O, no clock reads:
 * callers pass `currentMonth`). Turns a selection ("YTD ending Sep 2026", "Last quarter",
 * "Jan–Mar 2026") into concrete months, ISO dates, plain-English labels and an optional
 * comparison window.
 *
 * FISCAL-YEAR AWARE. `fyStartMonth` (1–12, core.organizations / core.locations
 * .fiscal_year_start_month) decides quarters, year-to-date and "last year". A fiscal year is
 * named by the calendar year it ENDS in (FY 2027 = Jul 2026–Jun 2027) — the same convention as
 * the report engine (lib/reports/engine/periods.ts `fiscalYearLabel`) and the metrics budget
 * fold (lib/metrics/fold.ts `budgetMonth`). Calendar-year tenants read plain years ("YTD 2026").
 *
 * The basis vocabulary is a superset of the metrics engine's `Basis` (month · qtd · ytd · ttm)
 * plus whole windows (quarter · fy) and an explicit range, and the comparison vocabulary is the
 * metrics engine's `ComparisonKind` — so a resolved period can be handed to either engine.
 *
 * All arithmetic is on month indexes (year × 12 + month − 1); dates are built in UTC, so a
 * server or browser timezone can never shift a month.
 */

export type MonthKey = string; // 'YYYY-MM'

/** How the window is built from its end month. */
export type PeriodBasis = 'month' | 'qtd' | 'quarter' | 'ytd' | 'fy' | 'ttm' | 'range';
export const PERIOD_BASES: readonly PeriodBasis[] = ['month', 'qtd', 'quarter', 'ytd', 'fy', 'ttm', 'range'];

/** What the period is compared with (same names as lib/metrics ComparisonKind). */
export type PeriodComparison = 'none' | 'prior_period' | 'prior_year' | 'budget';
export const PERIOD_COMPARISONS: readonly PeriodComparison[] = ['none', 'prior_period', 'prior_year', 'budget'];

/** The relative presets a picker offers. A preset re-resolves against today on every visit. */
export type PeriodPresetId =
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'ytd'
  | 'last_year'
  | 'ttm'
  | 'last_12_closed'
  | 'custom';

export interface PeriodSelection {
  basis: PeriodBasis;
  /** The last month in the window (for quarter / fy: any month inside; it is snapped). */
  end: MonthKey;
  /** range only: the first month. */
  start?: MonthKey;
  compare?: PeriodComparison;
  /** Set when the selection came from a relative preset (persisted so "YTD" stays YTD). */
  preset?: PeriodPresetId;
}

export interface PeriodContext {
  /** 1–12; anything else is treated as January. */
  fyStartMonth: number;
  /** Today's month in the org's timezone — the latest selectable month. */
  currentMonth: MonthKey;
  /** Books closed (HARD_CLOSE, contiguous) through this month, when known. */
  closedThrough?: MonthKey | null;
}

export interface ResolvedWindow {
  start: MonthKey;
  end: MonthKey;
  /** 'YYYY-MM-01' */
  startDate: string;
  /** Last day of `end`, 'YYYY-MM-DD' (leap years honoured). */
  endDate: string;
  /** Every month in the window, ascending. */
  months: MonthKey[];
  /** "Sep 2026", "YTD 2026", "TTM to Sep 2026", "Q3 2026", "FY 2025", "Jan–Mar 2026". */
  label: string;
}

export interface ResolvedComparison extends ResolvedWindow {
  kind: Exclude<PeriodComparison, 'none'>;
  /** "Prior period", "Prior year", "Budget". */
  kindLabel: string;
  /** "vs Aug 2026", "vs YTD 2025", "vs budget". */
  vsLabel: string;
}

export interface ResolvedPeriod extends ResolvedWindow {
  basis: PeriodBasis;
  preset: PeriodPresetId | null;
  /** "Jan 2026 – Sep 2026 · 9 months" — the explicit span under the short label. */
  spanLabel: string;
  monthCount: number;
  /** Fiscal year (end-year convention) the window ends in. */
  fiscalYear: number;
  /** "2026" for calendar-year tenants, "FY 2027" otherwise. */
  fiscalYearLabel: string;
  /** Some month in the window is not closed (after closedThrough, or closedThrough unknown → null). */
  includesOpenMonths: boolean | null;
  /** Some month in the window is after the current month (whole quarter / fiscal year). */
  includesFuture: boolean;
  compare: PeriodComparison;
  comparison: ResolvedComparison | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

// ─────────────────────────────────────────────────────────────────────────────
// Month arithmetic
// ─────────────────────────────────────────────────────────────────────────────

export function isMonthKey(v: unknown): v is MonthKey {
  return typeof v === 'string' && KEY_RE.test(v);
}

export function normalizeFyStart(m: number | null | undefined): number {
  const n = Number(m);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}

function idx(key: MonthKey): number {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Invalid month '${key}' (expected YYYY-MM)`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

function key(i: number): MonthKey {
  const y = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

export function monthKeyOf(year: number, month: number): MonthKey {
  return key(year * 12 + month - 1);
}

export function parseMonth(k: MonthKey): { year: number; month: number } {
  const i = idx(k);
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
}

export function addMonths(k: MonthKey, n: number): MonthKey {
  return key(idx(k) + n);
}

/** b − a in whole months. */
export function monthDiff(a: MonthKey, b: MonthKey): number {
  return idx(b) - idx(a);
}

export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let i = idx(from); i <= idx(to) && out.length < 600; i++) out.push(key(i));
  return out;
}

export function minMonth(a: MonthKey, b: MonthKey): MonthKey {
  return a <= b ? a : b;
}

export function maxMonth(a: MonthKey, b: MonthKey): MonthKey {
  return a >= b ? a : b;
}

/** Last day of the month, ISO (UTC — Feb 2028 → 2028-02-29). */
export function monthEndDate(k: MonthKey): string {
  const { year, month } = parseMonth(k);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function monthStartDate(k: MonthKey): string {
  return `${k}-01`;
}

/** The month an ISO date falls in. */
export function monthOfDate(iso: string): MonthKey {
  return iso.slice(0, 7);
}

/** "Sep 2026" */
export function monthLabel(k: MonthKey): string {
  const { year, month } = parseMonth(k);
  return `${MONTHS[month - 1]} ${year}`;
}

/** "Sep" */
export function monthShort(k: MonthKey): string {
  return MONTHS[parseMonth(k).month - 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fiscal calendar
// ─────────────────────────────────────────────────────────────────────────────

/** First month of the fiscal year containing `k`. */
export function fiscalYearStart(k: MonthKey, fyStartMonth: number): MonthKey {
  const fy = normalizeFyStart(fyStartMonth);
  const { year, month } = parseMonth(k);
  return monthKeyOf(month >= fy ? year : year - 1, fy);
}

export function fiscalYearEnd(k: MonthKey, fyStartMonth: number): MonthKey {
  return addMonths(fiscalYearStart(k, fyStartMonth), 11);
}

/** Fiscal year number (the calendar year the fiscal year ENDS in). */
export function fiscalYearOf(k: MonthKey, fyStartMonth: number): number {
  return parseMonth(fiscalYearEnd(k, fyStartMonth)).year;
}

/** "2026" for a calendar-year tenant, "FY 2027" otherwise. */
export function fiscalYearName(fiscalYear: number, fyStartMonth: number): string {
  return normalizeFyStart(fyStartMonth) === 1 ? String(fiscalYear) : `FY ${fiscalYear}`;
}

/** The 12 months of fiscal year `fiscalYear`, in fiscal order. */
export function fiscalYearMonths(fiscalYear: number, fyStartMonth: number): MonthKey[] {
  const fy = normalizeFyStart(fyStartMonth);
  const lastMonth = monthKeyOf(fiscalYear, fy === 1 ? 12 : fy - 1);
  return monthRange(addMonths(lastMonth, -11), lastMonth);
}

/** First month of the fiscal quarter containing `k`. */
export function fiscalQuarterStart(k: MonthKey, fyStartMonth: number): MonthKey {
  const ys = fiscalYearStart(k, fyStartMonth);
  return addMonths(ys, Math.floor(monthDiff(ys, k) / 3) * 3);
}

/** 1–4 */
export function fiscalQuarterOf(k: MonthKey, fyStartMonth: number): number {
  return Math.floor(monthDiff(fiscalYearStart(k, fyStartMonth), k) / 3) + 1;
}

/** "Q3 2026" / "Q1 FY 2027" */
export function quarterName(k: MonthKey, fyStartMonth: number): string {
  return `Q${fiscalQuarterOf(k, fyStartMonth)} ${fiscalYearName(fiscalYearOf(k, fyStartMonth), fyStartMonth)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows
// ─────────────────────────────────────────────────────────────────────────────

/** Snap/validate a selection's end and start for its basis (quarter → quarter end, fy → FY end). */
export function windowBounds(sel: Pick<PeriodSelection, 'basis' | 'end' | 'start'>, fyStartMonth: number): { start: MonthKey; end: MonthKey } {
  const end = sel.end;
  switch (sel.basis) {
    case 'month':
      return { start: end, end };
    case 'qtd':
      return { start: fiscalQuarterStart(end, fyStartMonth), end };
    case 'quarter': {
      const qs = fiscalQuarterStart(end, fyStartMonth);
      return { start: qs, end: addMonths(qs, 2) };
    }
    case 'ytd':
      return { start: fiscalYearStart(end, fyStartMonth), end };
    case 'fy':
      return { start: fiscalYearStart(end, fyStartMonth), end: fiscalYearEnd(end, fyStartMonth) };
    case 'ttm':
      return { start: addMonths(end, -11), end };
    case 'range': {
      const start = sel.start && isMonthKey(sel.start) ? sel.start : end;
      return start <= end ? { start, end } : { start: end, end: start };
    }
    default: {
      const never: never = sel.basis;
      return never;
    }
  }
}

/** "Jan–Mar 2026", "Nov 2025–Feb 2026", "Mar 2026". */
export function rangeName(start: MonthKey, end: MonthKey): string {
  if (start === end) return monthLabel(end);
  const a = parseMonth(start);
  const b = parseMonth(end);
  if (a.year === b.year) return `${MONTHS[a.month - 1]}–${MONTHS[b.month - 1]} ${b.year}`;
  return `${monthLabel(start)}–${monthLabel(end)}`;
}

function windowLabel(basis: PeriodBasis, start: MonthKey, end: MonthKey, fyStartMonth: number): string {
  switch (basis) {
    case 'month':
      return monthLabel(end);
    case 'qtd':
      // A to-date window that reached the quarter's last month IS the quarter.
      return addMonths(start, 2) === end ? quarterName(end, fyStartMonth) : `${quarterName(end, fyStartMonth)} to date`;
    case 'quarter':
      return quarterName(end, fyStartMonth);
    case 'ytd':
      return `YTD ${fiscalYearName(fiscalYearOf(end, fyStartMonth), fyStartMonth)}`;
    case 'fy':
      return `FY ${fiscalYearOf(end, fyStartMonth)}`;
    case 'ttm':
      return `TTM to ${monthLabel(end)}`;
    case 'range':
      return rangeName(start, end);
    default: {
      const never: never = basis;
      return never;
    }
  }
}

function buildWindow(basis: PeriodBasis, start: MonthKey, end: MonthKey, fyStartMonth: number): ResolvedWindow {
  return {
    start,
    end,
    startDate: monthStartDate(start),
    endDate: monthEndDate(end),
    months: monthRange(start, end),
    label: windowLabel(basis, start, end, fyStartMonth),
  };
}

/**
 * Months to step back for "prior period". Mirrors lib/metrics `priorPeriodShift` for the shared
 * bases (month 1 · qtd 3 · ytd 12 · ttm 12); a whole quarter steps 3, a fiscal year 12 and a
 * custom range by its own length.
 */
export function priorPeriodShift(basis: PeriodBasis, monthCount: number): number {
  switch (basis) {
    case 'month':
      return 1;
    case 'qtd':
    case 'quarter':
      return 3;
    case 'ytd':
    case 'fy':
    case 'ttm':
      return 12;
    case 'range':
      return Math.max(1, monthCount);
    default: {
      const never: never = basis;
      return never;
    }
  }
}

const COMPARISON_NAMES: Record<Exclude<PeriodComparison, 'none'>, string> = {
  prior_period: 'Prior period',
  prior_year: 'Prior year',
  budget: 'Budget',
};

export function comparisonName(kind: PeriodComparison): string {
  return kind === 'none' ? 'No comparison' : COMPARISON_NAMES[kind];
}

export function resolveComparison(
  basis: PeriodBasis,
  win: { start: MonthKey; end: MonthKey; months: MonthKey[] },
  kind: PeriodComparison,
  fyStartMonth: number,
): ResolvedComparison | null {
  if (kind === 'none') return null;
  if (kind === 'budget') {
    const w = buildWindow(basis, win.start, win.end, fyStartMonth);
    return { ...w, kind, kindLabel: COMPARISON_NAMES.budget, vsLabel: 'vs budget' };
  }
  const shift = kind === 'prior_year' ? 12 : priorPeriodShift(basis, win.months.length);
  const start = addMonths(win.start, -shift);
  const end = addMonths(win.end, -shift);
  const w = buildWindow(basis, start, end, fyStartMonth);
  return { ...w, kind, kindLabel: COMPARISON_NAMES[kind], vsLabel: `vs ${w.label}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────────────────────

export interface PresetDef {
  id: PeriodPresetId;
  label: string;
  /** The basis the preset produces (custom: range). */
  basis: PeriodBasis;
}

export const PERIOD_PRESETS: readonly PresetDef[] = [
  { id: 'this_month', label: 'This month', basis: 'month' },
  { id: 'last_month', label: 'Last month', basis: 'month' },
  { id: 'this_quarter', label: 'This quarter', basis: 'qtd' },
  { id: 'last_quarter', label: 'Last quarter', basis: 'quarter' },
  { id: 'ytd', label: 'Year to date', basis: 'ytd' },
  { id: 'last_year', label: 'Last year', basis: 'fy' },
  { id: 'ttm', label: 'Trailing 12 months', basis: 'ttm' },
  { id: 'last_12_closed', label: 'Last 12 closed months', basis: 'ttm' },
  { id: 'custom', label: 'Custom range', basis: 'range' },
];

export function isPresetId(v: unknown): v is PeriodPresetId {
  return typeof v === 'string' && PERIOD_PRESETS.some((p) => p.id === v);
}

/** The selection a preset means today. */
export function presetSelection(id: PeriodPresetId, ctx: PeriodContext): PeriodSelection {
  const fy = normalizeFyStart(ctx.fyStartMonth);
  const cur = ctx.currentMonth;
  switch (id) {
    case 'this_month':
      return { basis: 'month', end: cur, preset: id };
    case 'last_month':
      return { basis: 'month', end: addMonths(cur, -1), preset: id };
    case 'this_quarter':
      return { basis: 'qtd', end: cur, preset: id };
    case 'last_quarter':
      return { basis: 'quarter', end: addMonths(fiscalQuarterStart(cur, fy), -1), preset: id };
    case 'ytd':
      return { basis: 'ytd', end: cur, preset: id };
    case 'last_year':
      return { basis: 'fy', end: addMonths(fiscalYearStart(cur, fy), -1), preset: id };
    case 'ttm':
      return { basis: 'ttm', end: cur, preset: id };
    case 'last_12_closed': {
      const closed = ctx.closedThrough && isMonthKey(ctx.closedThrough) ? minMonth(ctx.closedThrough, cur) : addMonths(cur, -1);
      return { basis: 'ttm', end: closed, preset: id };
    }
    case 'custom':
      return { basis: 'range', start: addMonths(cur, -2), end: cur, preset: id };
    default: {
      const never: never = id;
      return never;
    }
  }
}

/** Which preset (if any) a concrete selection equals today — so a URL-loaded period still lights its preset. */
export function matchPreset(sel: PeriodSelection, ctx: PeriodContext, allowed?: readonly PeriodPresetId[]): PeriodPresetId | null {
  const fy = normalizeFyStart(ctx.fyStartMonth);
  const target = windowBounds(sel, fy);
  for (const p of PERIOD_PRESETS) {
    if (p.id === 'custom') continue;
    if (allowed && !allowed.includes(p.id)) continue;
    const ps = presetSelection(p.id, ctx);
    if (ps.basis !== sel.basis) continue;
    const b = windowBounds(ps, fy);
    if (b.start === target.start && b.end === target.end) return p.id;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp a selection so a to-date window never ends in the future (whole quarter / FY may). */
export function clampSelection(sel: PeriodSelection, ctx: PeriodContext): PeriodSelection {
  const cur = ctx.currentMonth;
  const fy = normalizeFyStart(ctx.fyStartMonth);
  if (!isMonthKey(sel.end)) return { ...sel, end: cur };
  if (sel.basis === 'quarter' || sel.basis === 'fy') {
    // The window must have started by now.
    const b = windowBounds(sel, fy);
    return b.start > cur ? { ...sel, end: cur } : sel;
  }
  if (sel.basis === 'range') {
    const b = windowBounds(sel, fy); // ordered start ≤ end
    const end = minMonth(b.end, cur);
    return { ...sel, start: minMonth(b.start, end), end };
  }
  return { ...sel, end: minMonth(sel.end, cur) };
}

export function resolvePeriod(selection: PeriodSelection, ctx: PeriodContext): ResolvedPeriod {
  const fy = normalizeFyStart(ctx.fyStartMonth);
  const sel = clampSelection(selection, ctx);
  const { start, end } = windowBounds(sel, fy);
  const win = buildWindow(sel.basis, start, end, fy);
  const fiscalYear = fiscalYearOf(end, fy);
  const n = win.months.length;
  const closed = ctx.closedThrough && isMonthKey(ctx.closedThrough) ? ctx.closedThrough : null;
  const compare = sel.compare ?? 'none';
  return {
    ...win,
    basis: sel.basis,
    preset: sel.preset ?? null,
    spanLabel: n === 1 ? monthLabel(start) : `${monthLabel(start)} – ${monthLabel(end)} · ${n} months`,
    monthCount: n,
    fiscalYear,
    fiscalYearLabel: fiscalYearName(fiscalYear, fy),
    includesOpenMonths: closed === null ? null : end > closed,
    includesFuture: end > ctx.currentMonth,
    compare,
    comparison: resolveComparison(sel.basis, win, compare, fy),
  };
}

/**
 * The report engine's PeriodSpec shape (lib/reports/engine/types.ts), built structurally so the
 * report viewer can adopt the picker without this module importing the engine.
 */
export function toReportPeriodSpec(p: ResolvedPeriod): { preset: 'month' | 'quarter' | 'year' | 'qtd' | 'ytd' | 'ttm' | 'custom'; asOf: string; start?: string; end?: string } {
  switch (p.basis) {
    case 'month':
      return { preset: 'month', asOf: p.endDate };
    case 'quarter':
      return { preset: 'quarter', asOf: p.endDate };
    case 'fy':
      return { preset: 'year', asOf: p.endDate };
    case 'qtd':
      return { preset: 'qtd', asOf: p.endDate };
    case 'ytd':
      return { preset: 'ytd', asOf: p.endDate };
    case 'ttm':
      return { preset: 'ttm', asOf: p.endDate };
    case 'range':
      return { preset: 'custom', asOf: p.endDate, start: p.startDate, end: p.endDate };
    default: {
      const never: never = p.basis;
      return never;
    }
  }
}

/** The month a 'YYYY-MM-DD' "today" falls in (validates; falls back to the UTC clock month). */
export function currentMonthOf(todayIso: string | null | undefined, now: Date = new Date()): MonthKey {
  const k = typeof todayIso === 'string' ? todayIso.slice(0, 7) : '';
  return isMonthKey(k) ? k : now.toISOString().slice(0, 7);
}
