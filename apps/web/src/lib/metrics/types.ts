/**
 * Metric registry — core types (Wave 3B, FPB-reports-fpna §1.15a).
 *
 * A metric is a typed expression tree over named inputs. Inputs are:
 *   - GL account CLASSES (revenue, cash, AR…) resolved by role / type / sub-type,
 *     never by hard-coded account number (canon §2);
 *   - budget flows for the same classes;
 *   - OPERATIONAL inputs from sub-ledgers (AR/AP aging, jobs, payroll, dealer units…);
 *   - other metrics, time shifts and fixed-basis windows.
 * The evaluator turns an expression into a value or an honest "can't compute" reason.
 */

import type { MonthKey } from '@/lib/analytics/months';

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type MetricUnit = 'money' | 'percent' | 'ratio' | 'days' | 'count' | 'times' | 'months' | 'points';

export type MetricDirection = 'higher_better' | 'lower_better' | 'neutral';

/** The window a flow is summed over, ending at the period-end month. */
export type Basis = 'month' | 'qtd' | 'ytd' | 'ttm';

export type ComparisonKind = 'prior_period' | 'prior_year' | 'budget' | 'none';

export type Audience = 'owner' | 'cfo' | 'controller' | 'lender' | 'construction' | 'dealer' | 'practice';

export type MetricGroup =
  | 'growth'
  | 'profitability'
  | 'plan'
  | 'liquidity'
  | 'working_capital'
  | 'receivables'
  | 'payables'
  | 'leverage'
  | 'returns'
  | 'efficiency'
  | 'construction'
  | 'dealer'
  | 'practice'
  | 'strategic';

export type Requirement =
  | 'gl'
  | 'budget'
  | 'headcount'
  | 'jobs'
  | 'ar_subledger'
  | 'ap_subledger'
  | 'inventory'
  | 'dealer'
  | 'practice'
  | 'addbacks'
  | 'covenants'
  | 'ap_discounts';

/** Why a figure cannot be stated (FPB AC-K4). */
export type CannotComputeReason =
  | 'not_enough_history'
  | 'not_on_file'
  | 'not_mapped'
  | 'not_meaningful'
  | 'no_approved_budget'
  | 'no_jobs'
  | 'zero_denominator';

// ── Inputs ───────────────────────────────────────────────────────────────────

/** GL account classes the data source resolves to sets of accounts. */
export type AccountClass =
  // P&L flows
  | 'revenue'
  | 'cogs'
  | 'opex'
  | 'other_income'
  | 'other_expense'
  | 'da_operating'
  | 'da_opex'
  | 'da_total'
  | 'interest_expense'
  | 'income_tax_expense'
  | 'payroll_expense'
  | 'variable_opex'
  // Activity on balance-sheet accounts (flows)
  | 'capex'
  | 'debt_repaid'
  | 'debt_drawn'
  | 'distributions'
  | 'contributions'
  // Balances
  | 'cash'
  | 'ar'
  | 'inventory'
  | 'current_assets'
  | 'current_liabilities'
  | 'total_assets'
  | 'total_liabilities'
  | 'ap'
  | 'total_debt'
  | 'intangibles'
  | 'retainage_receivable'
  | 'retainage_payable'
  | 'underbillings'
  | 'overbillings'
  | 'customer_deposits'
  | 'floor_plan_payable';

/** Non-GL inputs from sub-ledgers and operations. */
export type OperationalKey =
  // AR sub-ledger (month-end balances unless noted)
  | 'ar_open'
  | 'ar_current'
  | 'ar_1_30'
  | 'ar_31_60'
  | 'ar_61_90'
  | 'ar_over_90'
  | 'credit_sales' // flow: invoices issued
  | 'customer_days_to_pay_weighted' // flow: Σ(days to pay × amount) for invoices paid in the month
  | 'customer_paid_amount' // flow: amount of invoices fully paid in the month
  // AP sub-ledger
  | 'ap_open'
  | 'ap_current'
  | 'ap_1_30'
  | 'ap_31_60'
  | 'ap_61_90'
  | 'ap_over_90'
  | 'purchases' // flow: bills entered
  | 'discounts_offered' // flow
  | 'discounts_taken' // flow
  // People
  | 'headcount'
  // Jobs (month-end snapshot)
  | 'jobs_active'
  | 'backlog'
  | 'wip_underbillings'
  | 'wip_overbillings'
  | 'cost_to_complete'
  | 'gp_in_backlog'
  | 'job_contract_value'
  | 'job_estimated_gp'
  | 'job_fade'
  // Dealer
  | 'units_in_stock'
  | 'unit_days_in_stock'
  | 'units_aged'
  | 'warranty_open'
  | 'warranty_claimed' // flow
  // Practice / books health
  | 'close_days'
  | 'items_processed' // flow
  | 'bookkeepers'
  // Add-backs and covenants
  | 'addbacks' // flow
  | 'covenant_min_headroom';

/**
 * Where a balance is read:
 *   end            balance at the end of the window
 *   start          balance at the end of the month before the window (opening)
 *   average        (start + end) ÷ 2
 *   window_average mean of every month-end in the window
 */
export type BalanceAt = 'end' | 'start' | 'average' | 'window_average';

export type ConcentrationDataset = 'customer_revenue' | 'vendor_spend';
export type ConcentrationMeasure = 'top1' | 'top5' | 'hhi';

// ── Expression tree ─────────────────────────────────────────────────────────

export type Expr =
  | { op: 'flow'; cls: AccountClass }
  | { op: 'balance'; cls: AccountClass; at: BalanceAt }
  | { op: 'budget'; cls: AccountClass }
  | { op: 'operational'; key: OperationalKey; at?: BalanceAt; minMonths?: number }
  | { op: 'metric'; key: string }
  | { op: 'const'; value: number; label?: string }
  | { op: 'days' }
  | { op: 'add'; args: Expr[] }
  | { op: 'sub'; a: Expr; b: Expr }
  | { op: 'mul'; args: Expr[] }
  | { op: 'div'; num: Expr; den: Expr; guard?: 'nonzero' | 'positive' }
  | { op: 'neg'; arg: Expr }
  | { op: 'growth'; arg: Expr; lagMonths: number }
  | { op: 'cagr'; arg: Expr; years: number }
  | { op: 'shift'; arg: Expr; months: number }
  | { op: 'basis'; arg: Expr; basis: Basis }
  | { op: 'trailing_avg'; arg: Expr; months: number }
  | { op: 'positive'; arg: Expr; why: string }
  | { op: 'concentration'; dataset: ConcentrationDataset; measure: ConcentrationMeasure }
  /** Use `value` (with `note`) when `arg` cannot be computed for one of `when`. */
  | { op: 'fallback'; arg: Expr; value: number; when: CannotComputeReason[]; note: string };

// ── Definitions ─────────────────────────────────────────────────────────────

export interface BenchmarkBand {
  label: string;
  /** Inclusive lower bound in PRESENTATION units (percent as 0–100, ratios as-is). */
  min?: number;
  /** Exclusive upper bound in presentation units. */
  max?: number;
  tone: 'good' | 'watch' | 'poor';
}

export interface MetricBenchmark {
  bands: BenchmarkBand[];
  source: string;
}

export interface MetricDefinition {
  key: string;
  name: string;
  /** One or two plain-English sentences — the (i) tooltip. */
  definition: string;
  group: MetricGroup;
  formula: Expr;
  unit: MetricUnit;
  direction: MetricDirection;
  period: {
    nature: 'flow' | 'balance' | 'mixed';
    /** 'request' = follows the dashboard basis; a Basis = always evaluated on that window. */
    basis: 'request' | Basis;
  };
  requires: Requirement[];
  audiences: Audience[];
  benchmark?: MetricBenchmark;
  /** Shown under the figure, e.g. "Add-backs are documented with a reason". */
  notes?: string[];
}

// ── Dataset (what a data source loads; the evaluator reads only this) ───────

/** Monthly GL flows for one class, plus the balance before the first month. */
export interface GlClassSeries {
  /** Balance at the end of the month before `MetricDataset.rangeStart` (net classes only). */
  opening: number;
  /** Net flow per month in the class's measure (integer cents). Missing month = 0 activity. */
  months: Partial<Record<MonthKey, number>>;
}

export interface CompanyDataset {
  id: string;
  name: string;
  /** Group ownership 0..100 as of the period end; null = no ownership row (assumed 100%). */
  ownershipPct: number | null;
  /** No figures before this month (acquisition / "in group from"). */
  inGroupFrom: MonthKey | null;
  /** First month with posted GL activity (books start). Null = no GL on file. */
  firstMonthOnFile: MonthKey | null;
  /** Latest HARD_CLOSE month (books closed through). */
  closedThrough: MonthKey | null;
  gl: Partial<Record<AccountClass, GlClassSeries>>;
  budget: Partial<Record<AccountClass, Partial<Record<MonthKey, number>>>>;
  /** Fiscal years with an approved (active) budget version. */
  budgetApprovedFy: number[];
  operational: Partial<Record<OperationalKey, Partial<Record<MonthKey, number>>>>;
  /** Revenue by customer per month (cents) — concentration. */
  customerRevenue?: Partial<Record<MonthKey, Record<string, number>>>;
  /** Spend by vendor per month (cents) — concentration. */
  vendorSpend?: Partial<Record<MonthKey, Record<string, number>>>;
}

export interface ClassMapping {
  accountIds: string[];
  /** How the accounts were found (shown in the drill and the not-mapped message). */
  via: ('role' | 'role_default_number' | 'type' | 'name')[];
}

export interface MetricDataset {
  /** Adapter id ("gl-queries-v1", "period-balances-3a"). */
  source: string;
  fyStartMonth: number;
  /** First month with flows in this dataset (balances before it are not derivable). */
  rangeStart: MonthKey;
  /** Latest month on file (data after it does not exist yet). */
  latestMonth: MonthKey;
  companies: CompanyDataset[];
  /** Org-level account mapping per class (drill + "not mapped" detection). */
  classMapping: Partial<Record<AccountClass, ClassMapping>>;
  /** Operational inputs this source can supply at all (others are "not on file"). */
  operationalAvailable: OperationalKey[];
}

// ── Requests & results ─────────────────────────────────────────────────────

export interface MetricScope {
  companyIds: string[];
  /** 'full' = each company at 100%; 'ownership' = × effective ownership %. */
  weighting: 'full' | 'ownership';
}

export interface EvaluateRequest {
  metric: string;
  scope: MetricScope;
  periodEnd: MonthKey;
  basis: Basis;
  comparison: ComparisonKind;
  /** Number of month-end points in the sparkline (0 = none). Default 12. */
  sparkline?: 0 | 12 | 24;
}

export type Outcome =
  | { status: 'ok'; value: number; raw: number }
  | { status: 'cannot_compute'; reason: CannotComputeReason; message: string };

export type Verdict = 'improvement' | 'erosion' | 'favourable' | 'unfavourable' | 'higher' | 'lower' | 'unchanged';

export interface MetricChange {
  /** current − comparison in presentation units (cents for money; points for percent). */
  delta: number;
  /** % change (×100) for non-percent units; null when n/m (base ≤ 0, sign flip, base 0). */
  pct: number | null;
  pctNotMeaningful: boolean;
  /** True when the delta is in percentage points (percent unit). */
  inPoints: boolean;
  verdict: Verdict;
  arrow: 'up' | 'down' | 'flat';
  /** "improvement", "erosion", "favourable"… plus the comparison label. */
  sentence: string;
}

export interface SparkPoint {
  month: MonthKey;
  /** Presentation-unit value; null for a gap (never drawn as 0). */
  value: number | null;
  preliminary: boolean;
  reason?: CannotComputeReason;
}

export interface DrillRef {
  input: string;
  label: string;
  kind: 'gl_flow' | 'gl_balance' | 'budget' | 'operational' | 'concentration';
  statement?: 'income_statement' | 'balance_sheet';
  accountIds?: string[];
  source?: string;
}

export interface MetricResult {
  key: string;
  name: string;
  unit: MetricUnit;
  direction: MetricDirection;
  period: { end: MonthKey; basis: Basis; from: MonthKey; to: MonthKey };
  current: Outcome;
  comparison: { kind: Exclude<ComparisonKind, 'none'>; outcome: Outcome; likeForLike: boolean } | null;
  change: MetricChange | null;
  sparkline: SparkPoint[];
  preliminary: boolean;
  scope: {
    weighting: MetricScope['weighting'];
    included: string[];
    excluded: { companyId: string; reason: CannotComputeReason; message: string }[];
    assumedFullOwnership: string[];
  };
  drill: DrillRef[];
  notes: string[];
}
