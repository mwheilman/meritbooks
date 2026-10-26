/**
 * Department budgets (Wave 4B, migration 189) — shared vocabulary and the API contract between
 * the budget routes and the /budgets workspace. docs/FPB-reports-fpna.md §4.11.
 *
 * Money is integer cents everywhere. Budget cells are NATURAL sign (revenue and expenses are both
 * positive), the same convention public.budgets has always used.
 */

export const VERSION_KINDS = ['BUDGET', 'REFORECAST'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

export const VERSION_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'LOCKED', 'SUPERSEDED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const VERSION_BASES = ['BLANK', 'MIGRATED', 'PRIOR_YEAR_ACTUALS', 'PRIOR_BUDGET', 'TEMPLATE', 'COPY', 'IMPORT', 'REFORECAST'] as const;
export type VersionBasis = (typeof VERSION_BASES)[number];

export const PLAN_STATUSES = ['NOT_STARTED', 'DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const LINE_SOURCES = ['MANUAL', 'IMPORT', 'TEMPLATE', 'PRIOR_YEAR', 'DRIVER', 'COPY', 'PASTE', 'MIGRATED', 'REFORECAST'] as const;
export type LineSource = (typeof LINE_SOURCES)[number];

export const DRIVER_METHODS = [
  'FIXED_MONTHLY',
  'ANNUAL_EVEN',
  'ANNUAL_SEASONAL',
  'PY_GROWTH',
  'PCT_OF_REVENUE',
  'HEADCOUNT_RATE',
  'UNITS_RATE',
  'PRIOR_BUDGET_GROWTH',
  'MANUAL',
] as const;
export type DriverMethod = (typeof DRIVER_METHODS)[number];

export const BRIDGE_DRIVERS = ['AUTO', 'HEADCOUNT', 'RATE', 'VOLUME', 'NEW_INITIATIVE', 'ONE_TIME', 'INFLATION'] as const;
export type BridgeDriver = (typeof BRIDGE_DRIVERS)[number];

export const DEPARTMENT_KINDS = [
  'SALES', 'MARKETING', 'OPERATIONS', 'SERVICE', 'PARTS', 'SHOP', 'CONSTRUCTION_PM', 'ADMIN', 'EXECUTIVE', 'FINANCE', 'OTHER',
] as const;
export type DepartmentKind = (typeof DEPARTMENT_KINDS)[number];

export const BVA_WINDOWS = ['MONTH', 'QTD', 'YTD', 'TTM'] as const;
export type BvaWindow = (typeof BVA_WINDOWS)[number];

/** Driver parameters, per method. Amounts cents, rates basis points (100 bps = 1%). */
export type DriverSpec =
  | { method: 'FIXED_MONTHLY'; monthlyCents: number }
  | { method: 'ANNUAL_EVEN'; annualCents: number }
  | { method: 'ANNUAL_SEASONAL'; annualCents: number }
  | { method: 'PY_GROWTH'; growthBps: number }
  | { method: 'PCT_OF_REVENUE'; pctBps: number }
  | { method: 'HEADCOUNT_RATE'; headcount: number; monthlyRateCents: number; burdenBps: number; startMonth: number }
  | { method: 'UNITS_RATE'; unitsPerMonth: number; rateCents: number; growthBps: number }
  | { method: 'PRIOR_BUDGET_GROWTH'; growthBps: number }
  | { method: 'MANUAL' };

export interface BudgetVersion {
  id: string;
  locationId: string;
  fiscalYear: number;
  kind: VersionKind;
  versionNumber: number;
  label: string;
  status: VersionStatus;
  isCurrent: boolean;
  parentVersionId: string | null;
  basis: VersionBasis;
  growthBps: number | null;
  dueDate: string | null;
  materialityCents: number;
  materialityBps: number;
  notes: string | null;
  createdBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  submitNote: string | null;
  returnedNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentLite {
  id: string;
  name: string;
  code: string;
  locationId: string | null;
}

export interface DepartmentPlan {
  id: string;
  versionId: string;
  departmentId: string;
  departmentName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  templateKey: string | null;
  templateVersion: number | null;
  status: PlanStatus;
  dueDate: string | null;
  targetRevenueCents: number | null;
  targetExpenseCents: number | null;
  gapNote: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  submitNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

/** One department row on the submission board. */
/**
 * A department's row status on the submission board: its plan's status, or — when the version
 * has no plan row for it — whether it is simply not part of the version ('NOT_IN_VERSION', e.g. a
 * company-level budget migrated in) or carries budget lines that never went through department
 * review ('NO_REVIEW'). Derived by `boardStatus` (lifecycle.ts).
 */
export type BoardStatus = PlanStatus | 'NOT_IN_VERSION' | 'NO_REVIEW';

export interface BoardRow {
  departmentId: string;
  departmentName: string;
  plan: DepartmentPlan | null;
  ownerUserId: string | null;
  ownerName: string | null;
  status: BoardStatus;
  dueDate: string | null;
  overdue: boolean;
  /** Budget totals for the version (natural sign). */
  revenueCents: number;
  expenseCents: number;
  /** Prior fiscal year actuals for the same department (natural sign). */
  pyRevenueCents: number;
  pyExpenseCents: number;
  /** Expense change vs prior year; null when PY expense is 0. */
  expenseChangePct: number | null;
  openComments: number;
  /** Plan total vs target gap (expense), cents; null when no target. */
  expenseGapCents: number | null;
  canEdit: boolean;
}

export interface BoardResponse {
  version: BudgetVersion;
  rows: BoardRow[];
  companyLevel: { revenueCents: number; expenseCents: number } | null;
  progress: { total: number; approved: number; submitted: number; overdue: number };
  access: BudgetAccessSummary;
}

export interface AccountLite {
  id: string;
  number: string;
  name: string;
  type: string;
  subType: string;
  groupName: string | null;
}

export interface GridRow {
  /** `${accountId}|${departmentId ?? ''}` */
  key: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: string;
  groupName: string | null;
  departmentId: string | null;
  /** Periods 1..12 (index 0 = period 1). */
  months: number[];
  adjustmentsCents: number;
  totalCents: number;
  /** Prior fiscal year actual for this account × department (natural sign). */
  pyActualCents: number;
  pyMonths: number[];
  driver: { method: DriverMethod; params: Record<string, number>; bridgeDriver: BridgeDriver; note: string | null } | null;
  sources: LineSource[];
  comments: number;
}

export interface GridResponse {
  version: BudgetVersion;
  departmentId: string | null;
  /** The department plan's status in this version (null = company level / no plan yet). */
  planStatus: PlanStatus | null;
  editable: boolean;
  lockReason: string | null;
  /** Months (1..12) whose fiscal period is SOFT_CLOSE / HARD_CLOSE — their budget can't change. */
  closedPeriods: number[];
  rows: GridRow[];
  accounts: AccountLite[];
  totals: { revenueCents: number; expenseCents: number; pyRevenueCents: number; pyExpenseCents: number };
}

export interface CellEdit {
  accountId: string;
  periodNumber: number;
  amountCents: number;
}

export interface BudgetAccessSummary {
  scope: 'ALL' | 'DEPARTMENTS';
  canView: boolean;
  canEdit: boolean;
  canApprove: boolean;
  ownedDepartmentIds: string[];
  userId: string;
}

export interface VersionsResponse {
  versions: BudgetVersion[];
  current: BudgetVersion | null;
  access: BudgetAccessSummary;
  departments: DepartmentLite[];
}

export interface BvaLine {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: string;
  groupName: string | null;
  nature: 'income' | 'expense';
  actualCents: number;
  budgetCents: number;
  pyCents: number;
  varianceCents: number;
  variancePct: number | null;
  pyChangeCents: number;
  pyChangePct: number | null;
  /** 'no_budget' when nothing was budgeted for the window: no F/U call (the UI shows "—"). */
  verdict: 'favourable' | 'unfavourable' | 'on_budget' | 'no_budget';
  material: boolean;
  explanation: VarianceNote | null;
}

export interface VarianceNote {
  id: string;
  body: string;
  status: 'OPEN' | 'RESOLVED' | 'EXPLAINED' | 'REVIEWED';
  authorUserId: string;
  authorName: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface BvaSection {
  key: 'revenue' | 'cogs' | 'opex' | 'other';
  label: string;
  actualCents: number;
  budgetCents: number;
  pyCents: number;
}

export interface BridgeStepOut {
  key: string;
  label: string;
  cents: number;
  residual?: boolean;
  /** The largest accounts inside the step (drill / tooltip). */
  detail?: Array<{ accountId: string; label: string; cents: number }>;
}

export interface BridgeOut {
  title: string;
  measure: 'contribution' | 'spend';
  direction: 'higher_is_better' | 'lower_is_better';
  start: { label: string; cents: number };
  steps: BridgeStepOut[];
  end: { label: string; cents: number };
  ties: boolean;
  note: string | null;
}

export interface DepartmentViewResponse {
  version: BudgetVersion | null;
  department: DepartmentLite | null;
  window: BvaWindow;
  period: { fiscalYear: number; month: number; label: string; from: string; to: string; pyFrom: string; pyTo: string };
  lines: BvaLine[];
  sections: BvaSection[];
  totals: { actualCents: number; budgetCents: number; pyCents: number; measure: 'contribution' | 'spend' };
  materialCount: number;
  bridges: { pyToBudget: BridgeOut; budgetToActual: BridgeOut; budgetToForecast: BridgeOut };
  forecastLabel: string;
  closedThrough: string | null;
  /** Latest month (1–12) of the fiscal year with any actual for this department; null = none yet. */
  latestActualMonth: number | null;
  access: BudgetAccessSummary;
}

export interface GlDrillLine {
  lineId: string;
  entryId: string;
  entryNumber: string;
  entryDate: string;
  memo: string | null;
  debitCents: number;
  creditCents: number;
  naturalCents: number;
}

export interface CompareRow {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: string;
  departmentId: string | null;
  departmentName: string | null;
  aCents: number;
  bCents: number;
  changeCents: number;
  changePct: number | null;
}

export interface CompareResponse {
  a: BudgetVersion;
  b: BudgetVersion;
  rows: CompareRow[];
  totals: { aRevenueCents: number; bRevenueCents: number; aExpenseCents: number; bExpenseCents: number };
}

export interface TemplateLine {
  key: string;
  label: string;
  selector: {
    types: Array<'REVENUE' | 'COGS' | 'OPEX' | 'OTHER'>;
    subTypes?: string[];
    /** Safe pattern (templates/pattern.ts: `a|b` alternatives, `*` wildcard, else literal; ≤ 100 chars) on the account group name. */
    group?: string;
    /** Safe pattern matched against the account name. */
    name?: string;
    /** Safe pattern that must NOT match the account name. */
    notName?: string;
  };
  method: DriverMethod;
  params: Record<string, number>;
  bridgeDriver?: BridgeDriver;
  required?: boolean;
  note?: string;
}

export interface BudgetTemplate {
  /** System templates: `system:<key>`; tenant templates: the row id. */
  id: string;
  scope: 'system' | 'tenant';
  key: string;
  version: number;
  name: string;
  departmentKind: DepartmentKind;
  description: string;
  basedOn: string | null;
  lines: TemplateLine[];
  kpis: string[];
}

export interface TemplatePreviewLine {
  line: TemplateLine;
  account: AccountLite | null;
  months: number[];
  annualCents: number;
  explain: string;
}

export interface BudgetComment {
  id: string;
  versionId: string | null;
  departmentId: string | null;
  accountId: string | null;
  periodNumber: number | null;
  parentId: string | null;
  kind: 'COMMENT' | 'JUSTIFY_REQUEST' | 'VARIANCE_EXPLANATION';
  status: 'OPEN' | 'RESOLVED' | 'EXPLAINED' | 'REVIEWED';
  body: string;
  authorUserId: string;
  authorName: string | null;
  periodKey: string | null;
  varianceWindow: BvaWindow | null;
  varianceCents: number | null;
  resolvedBy: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
}

/** Human labels (UI + exports). */
export const VERSION_STATUS_LABEL: Record<VersionStatus, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  LOCKED: 'Locked',
  SUPERSEDED: 'Superseded',
};

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  NOT_STARTED: 'Not started',
  DRAFT: 'Drafting',
  SUBMITTED: 'Submitted',
  RETURNED: 'Returned',
  APPROVED: 'Approved',
};

export const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  ...PLAN_STATUS_LABEL,
  NOT_IN_VERSION: 'Not in this version',
  NO_REVIEW: 'In the budget — no department review',
};

export const DRIVER_METHOD_LABEL: Record<DriverMethod, string> = {
  FIXED_MONTHLY: 'Fixed monthly',
  ANNUAL_EVEN: 'Annual, spread evenly',
  ANNUAL_SEASONAL: 'Annual, last year’s seasonality',
  PY_GROWTH: 'Last year’s actuals + growth %',
  PCT_OF_REVENUE: '% of department revenue',
  HEADCOUNT_RATE: 'Headcount × monthly rate',
  UNITS_RATE: 'Units × rate',
  PRIOR_BUDGET_GROWTH: 'Last year’s budget + growth %',
  MANUAL: 'Entered by hand',
};

export const BRIDGE_DRIVER_LABEL: Record<Exclude<BridgeDriver, 'AUTO'>, string> = {
  VOLUME: 'Volume',
  RATE: 'Rate / price',
  HEADCOUNT: 'Headcount',
  INFLATION: 'Inflation & cost changes',
  NEW_INITIATIVE: 'New initiatives',
  ONE_TIME: 'One-time items',
};
