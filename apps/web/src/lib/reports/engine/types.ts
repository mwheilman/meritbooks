/**
 * Report engine — PUBLIC CONTRACT (Wave 3A). Documented in docs/report-engine-api.md.
 *
 * Consumers: the statement viewer (app/(app)/reports), 3B metric registry (lib/metrics —
 * reads balances through `loadBalances` / `runReport`), 3C ChartCard (renders
 * `ReportResult.columns/rows` + `chartSeries`), 3D governance (`applyGovernance`), 3E flux.
 *
 * Conventions (binding):
 *   - Money is integer CENTS (JS number, always an integer). Never floats for money.
 *   - Internally every account amount is DEBIT-POSITIVE (debit − credit). A statement row
 *     carries a presentation `sign` so values in `ReportRow.values` are in PRESENTATION
 *     space (revenue positive, expense positive, liabilities positive, …).
 *   - Percent values (variance %, common-size %) are plain numbers in PERCENT units
 *     (12.5 = 12.5%), rounded to 0.1, or null when undefined (÷0).
 *   - Rounding ($K / $M) is PRESENTATION ONLY: the engine always returns exact cents;
 *     `formatAmount` rounds each figure independently from exact cents (no drift is
 *     carried into totals; totals are computed before rounding).
 *   - Account types are ASSET, LIABILITY, EQUITY, REVENUE, COGS, OPEX, OTHER (no EXPENSE).
 */

// ─── request ────────────────────────────────────────────────────────────────

export type StatementKind =
  | 'income_statement'
  | 'balance_sheet'
  | 'cash_flow'
  | 'equity_changes'
  | 'trial_balance'
  | 'gl_summary';

export type PeriodPreset = 'month' | 'quarter' | 'year' | 'mtd' | 'qtd' | 'ytd' | 'ttm' | 'custom';

export interface PeriodSpec {
  preset: PeriodPreset;
  /** Anchor date (ISO): the period that CONTAINS this date (or ends on it for to-date presets). */
  asOf: string;
  /** custom only */
  start?: string;
  /** custom only */
  end?: string;
}

/** How amount columns are split. `location` is an alias of `company` (a company = core.locations row). */
export type ColumnMode = 'single' | 'month' | 'quarter' | 'year' | 'company' | 'department' | 'class' | 'job' | 'location';

export type DimensionKey = 'department' | 'class' | 'job' | 'item';

export type CompareKind = 'prior_period' | 'prior_year' | 'budget' | 'forecast';

export type Basis = 'ACCRUAL' | 'CASH' | 'TAX' | 'CUSTOM';

export type Rounding = 'cents' | 'units' | 'thousands' | 'millions';

export interface AccountRange {
  /** inclusive account-number bounds (compared numerically when both are numeric, else lexically) */
  from: string;
  to: string;
}

export interface ReportFilters {
  accountIds?: string[];
  accountRanges?: AccountRange[];
  departmentIds?: string[];
  classIds?: string[];
  jobIds?: string[];
  itemIds?: string[];
}

export type LayoutRef = { kind: 'standard' } | { kind: 'ebitda' } | { kind: 'custom'; layoutId: string };

export interface ReportScope {
  /** Companies to include. Empty = every company the caller can see (client scope applied). */
  companyIds: string[];
  /**
   * Consolidate: with columns='company' renders companies → Combined → Eliminations →
   * Consolidated; with any other column mode the figures are consolidated (eliminated).
   */
  consolidate?: boolean;
}

export interface ReportRequest {
  statement: StatementKind;
  scope: ReportScope;
  period: PeriodSpec;
  columns: ColumnMode;
  /** For month/quarter/year columns: how many trailing buckets ending at the period (default 12 / 4 / 3). */
  columnCount?: number;
  /** Add a Total column after split columns (default true for P&L-type splits). */
  totalColumn?: boolean;
  /** Add a trailing-twelve-months column (P&L by month). */
  ttmColumn?: boolean;
  compare: CompareKind[];
  /** Apply comparisons to every amount column (default: true when columns='single', else only Total). */
  compareEach?: boolean;
  /** Emit $ and % variance columns for each comparison (default true). */
  variance?: boolean;
  basis: Basis;
  /** CUSTOM basis label (reporting_basis_adjustments.custom_label) */
  customBasisLabel?: string | null;
  rounding: Rounding;
  commonSize?: boolean;
  showZeroRows?: boolean;
  filters?: ReportFilters;
  layout?: LayoutRef;
  /** Trial balance: 'worksheet' (unadjusted / adjustments / adjusted) or 'simple'. */
  tbMode?: 'worksheet' | 'simple';
}

// ─── reference data the pure core consumes (the adapter loads these) ─────────

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

export interface AccountMeta {
  id: string;
  number: string;
  name: string;
  type: AccountType;
  subType: string;
  subTypeName: string;
  subTypeOrder: number;
  groupId: string;
  groupName: string;
  groupOrder: number;
  /** The account's own group when a role-based presentation line regrouped it (layouts select on this). */
  sourceGroupId?: string;
  order: number;
  normalBalance: 'DEBIT' | 'CREDIT';
  isBank: boolean;
  isEliminating: boolean;
  isActive: boolean;
  /** account_roles keys this account carries (org- or company-level) */
  roles: string[];
  /** accounts.cash_flow_category override (mig 185) */
  cashFlowCategory: CashFlowCategory | null;
}

export type CashFlowCategory = 'CASH' | 'OPERATING' | 'INVESTING' | 'FINANCING' | 'NONCASH';

export type EntryKind = 'STANDARD' | 'ADJUSTING' | 'CLOSING';

/** One aggregated store row (public.report_balances). `period` null = opening bucket (< from). */
export interface BalanceRow {
  companyId: string;
  accountId: string;
  /** 'YYYY-MM-01' or null for the opening bucket */
  period: string | null;
  kind: EntryKind;
  departmentId: string | null;
  classId: string | null;
  jobId: string | null;
  itemId: string | null;
  counterpartyId: string | null;
  debit: number;
  credit: number;
}

export interface BudgetRow {
  companyId: string;
  accountId: string;
  departmentId: string | null;
  /** 'YYYY-MM-01' */
  period: string;
  /** NATURAL sign (normal-balance positive) — budgets table convention */
  naturalCents: number;
}

/** Report-time basis delta (reporting_basis_adjustments or the live cash conversion). */
export interface BasisDelta {
  accountId: string;
  companyId: string | null;
  /** 'YYYY-MM-01' — whole-year rows are pinned to the fiscal year's last month */
  period: string;
  /** NATURAL signed delta (mig 147 convention) */
  naturalCents: number;
  description?: string | null;
}

export interface CompanyMeta {
  id: string;
  name: string;
  shortCode: string | null;
  fiscalYearStartMonth: number;
}

export interface DimensionMeta {
  id: string;
  name: string;
  code?: string | null;
}

export interface OwnershipMeta {
  entityId: string;
  method: 'FULL' | 'EQUITY' | 'NONE';
  ownershipPercent: number;
}

export interface PeriodStatusRow {
  companyId: string;
  /** 'YYYY-MM-01' */
  period: string;
  status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';
}

export interface EngineData {
  orgFiscalYearStartMonth: number;
  accounts: AccountMeta[];
  companies: CompanyMeta[];
  /** Companies actually in scope for this request (validated against client scope). */
  companyIds: string[];
  balances: BalanceRow[];
  budgets: BudgetRow[];
  basisDeltas: BasisDelta[];
  periodStatus: PeriodStatusRow[];
  dimensions: Partial<Record<DimensionKey, DimensionMeta[]>>;
  ownership: OwnershipMeta[];
  /** accumulated-depreciation accounts (fixed_assets.accumulated_depreciation_account_id) */
  accumulatedDepreciationIds: string[];
  /** live CASH-basis natural deltas per P&L cell, keyed by aggregate.basisKey(range, companyIds) */
  basisDeltasByCell?: Record<string, BasisDelta[]>;
  /** exact-date balances for ranges that cut a month, keyed by periods.rangeKey(range) */
  exactBalances?: Record<string, BalanceRow[]>;
  /** a custom layout, when request.layout.kind === 'custom' */
  customLayout?: CustomLayout | null;
  /** today's ISO date in the org timezone (partial-period warnings) */
  today: string;
  /**
   * In-group windows by company (pre-acquisition / post-disposal exclusion). Present only
   * when governance decided the window excludes for this caller and scope; flows outside a
   * company's window and point-in-time balances of a company outside its window at the
   * as-of month are left out of every statement except the trial balance and GL summary.
   */
  groupWindows?: Record<string, GroupWindow>;
}

// ─── custom row designer (report_layouts.rows) ───────────────────────────────

export interface AccountSelector {
  types?: AccountType[];
  subTypes?: string[];
  groupIds?: string[];
  roles?: string[];
  accountIds?: string[];
  ranges?: AccountRange[];
  /** synthetic balance-sheet earnings rows */
  synthetic?: Array<'re_prior' | 'ni_current'>;
  excludeAccountIds?: string[];
}

export type LayoutRowDef =
  | { id: string; kind: 'header'; label: string }
  | {
      id: string;
      kind: 'accounts';
      label: string;
      select: AccountSelector;
      /** presentation sign: +1 debit-positive (assets, costs), −1 credit-positive (revenue, liabilities, equity) */
      sign: 1 | -1;
      /** how the row expands: one line per account, per group (with accounts under), or a single line */
      expand?: 'accounts' | 'groups' | 'none';
      /** for variance F/U: is an increase good? (default: sign −1 → up, sign +1 → down) */
      goodWhen?: 'up' | 'down';
    }
  | {
      id: string;
      kind: 'subtotal';
      label: string;
      of: Array<{ id: string; sign: 1 | -1 }>;
      goodWhen?: 'up' | 'down';
      emphasis?: 'sub' | 'grand';
    }
  | {
      id: string;
      kind: 'formula';
      label: string;
      /** arithmetic over row ids in braces: "{gp} / {revenue} * 100", "{ebitda} + {addbacks}" */
      expr: string;
      /** amount = cents · percent = % (one decimal) · ratio = a multiple shown as "0.62×" */
      format: 'amount' | 'percent' | 'ratio';
      goodWhen?: 'up' | 'down';
    }
  | { id: string; kind: 'spacer' };

export interface CustomLayout {
  id: string;
  name: string;
  statement: 'PNL' | 'BS';
  rows: LayoutRowDef[];
}

// ─── result ─────────────────────────────────────────────────────────────────

export interface DateRange {
  /** ISO; null = from inception (balance-sheet columns) */
  start: string | null;
  end: string;
}

export type ColumnKind = 'amount' | 'variance_amount' | 'variance_pct' | 'common_size' | 'elimination' | 'total' | 'debit' | 'credit';

export type ColumnSource = 'actual' | 'budget' | 'forecast';

/** What a cell in this column drills to (combined with the row's account ids). */
export interface DrillScope {
  companyIds: string[];
  range: DateRange;
  /** dimension filter: value null = "Unassigned" (IS NULL) */
  dims?: Partial<Record<DimensionKey, string | null>>;
  kinds: EntryKind[];
  /**
   * per-company date bounds (inclusive ISO dates) AND-ed with `range` — set when a company
   * joins or leaves the group inside the range (pre-acquisition exclusion), so the drill
   * returns exactly the lines the cell summed.
   */
  windows?: Record<string, DrillWindow>;
}

export interface DrillWindow {
  from: string | null;
  to: string | null;
}

/**
 * A company's in-group window (governance, 3D `report_company_coverage`): the first and last
 * month ('YYYY-MM-01') it belongs to the group. null = open-ended. A company with no window
 * is in the group for every month.
 */
export interface GroupWindow {
  from: string | null;
  until: string | null;
}

export interface ReportColumn {
  id: string;
  label: string;
  sublabel?: string;
  kind: ColumnKind;
  source: ColumnSource;
  range: DateRange;
  /** variance / common-size columns point at the amount column they derive from */
  of?: string;
  /** variance columns: the comparison column */
  against?: string;
  /** when set, cells in this column are drillable */
  drill?: DrillScope | null;
  /** period status for the column: final (every month hard-closed) / preliminary / partial (in progress) */
  status?: 'final' | 'preliminary' | 'partial' | null;
  /** true for the current-period column (rendered on white) */
  current?: boolean;
  /** percent columns render values as % (not cents) */
  percent?: boolean;
}

export type RowKind = 'header' | 'group' | 'account' | 'subtotal' | 'total' | 'formula' | 'spacer' | 'check';

export interface ReportRow {
  id: string;
  kind: RowKind;
  label: string;
  depth: number;
  parentId?: string | null;
  accountId?: string | null;
  accountNumber?: string | null;
  /** accounts behind this row (drill: row accountIds × column drill scope) */
  accountIds?: string[];
  /** one value per column; cents for money columns, percent for percent columns, null = blank */
  values: Array<number | null>;
  /** F/U marker per column (variance columns only) */
  fu?: Array<'F' | 'U' | null>;
  goodWhen?: 'up' | 'down';
  /** row ids this total must equal (presentation space), e.g. [{id:'rev',sign:1},{id:'cogs',sign:-1}] */
  sumOf?: Array<{ id: string; sign: 1 | -1 }>;
  /** formula rows: percent format */
  percent?: boolean;
  /** formula rows: a ratio ("0.62×") — values are plain multiples, not cents */
  ratio?: boolean;
  /** value = drillSign × Σ(debit − credit) of the drilled GL lines (presentation sign) */
  drillSign?: 1 | -1;
  /** per-cell drill overrides (one per column; null = not drillable) — e.g. trial balance P&L rows */
  cellDrill?: Array<DrillScope | null>;
  /** synthetic (non-GL account) rows e.g. retained earnings not yet closed */
  synthetic?: boolean;
  collapsible?: boolean;
  emphasis?: 'sub' | 'grand';
}

export interface ReportWarning {
  code:
    | 'OUT_OF_BALANCE'
    | 'CASH_DOES_NOT_TIE'
    | 'PARTIAL_PERIOD'
    | 'UNMAPPED_ACCOUNTS'
    | 'BASIS_LIMITED'
    | 'ELIMINATION_RESIDUAL'
    | 'NON_FULL_ENTITIES'
    | 'NO_BUDGET'
    | 'TRUNCATED_COLUMNS';
  message: string;
  amountCents?: number;
}

export interface ReportResult {
  statement: StatementKind;
  title: string;
  subtitle: string;
  basis: Basis;
  basisLabel: string;
  rounding: Rounding;
  range: DateRange;
  columns: ReportColumn[];
  rows: ReportRow[];
  warnings: ReportWarning[];
  notes: string[];
  companies: Array<{ id: string; name: string }>;
  /**
   * checks that must hold (balance sheet balances, CF ties, TB balances). differenceCents is
   * null when governance withheld a column (the difference would reveal withheld figures).
   */
  checks: Array<{ id: string; label: string; ok: boolean; differenceCents: number | null }>;
  /** convenience series for ChartCard (3C): one series per amount column for the key rows */
  chartSeries: ChartSeries[];
  generatedAt: string;
  /** governance fields 3D fills (books closed through, release state, watermark) */
  governance?: GovernanceInfo | null;
  /** companies whose in-group window the engine applied (figures exclude months outside it) */
  groupWindowCompanyIds?: string[];
}

export interface ChartSeries {
  rowId: string;
  label: string;
  points: Array<{ columnId: string; label: string; cents: number | null }>;
}

export interface GovernanceInfo {
  booksClosedThrough?: string | null;
  released?: boolean;
  watermark?: string | null;
  restated?: boolean;
  [key: string]: unknown;
}

// ─── drill ──────────────────────────────────────────────────────────────────

export interface DrillRequest {
  accountIds: string[];
  companyIds: string[];
  range: DateRange;
  dims?: Partial<Record<DimensionKey | 'counterparty', string | null>>;
  kinds?: EntryKind[];
  windows?: Record<string, DrillWindow>;
  limit?: number;
  offset?: number;
}

export interface DrillLine {
  lineId: string;
  entryId: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  memo: string | null;
  sourceModule: string | null;
  sourceId: string | null;
  companyId: string;
  accountId: string;
  departmentId: string | null;
  classId: string | null;
  jobId: string | null;
  debitCents: number;
  creditCents: number;
  /** running Σ(debit − credit) across the whole filtered set, in date order */
  runningNetCents: number;
  /** links: journal entry + source document when known */
  entryHref: string;
  sourceHref: string | null;
  sourceLabel: string | null;
}

export interface DrillResult {
  totalCount: number;
  debitCents: number;
  creditCents: number;
  /** Σ(debit − credit) over the whole set (debit-positive) */
  netCents: number;
  lines: DrillLine[];
  limit: number;
  offset: number;
}
