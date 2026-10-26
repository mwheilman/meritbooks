/**
 * FP&A workspace (Wave 4A, FPB-reports-fpna §4.13) — the JSON contract between the
 * server view builders and the /fpna screens, the PDF and the AI fact sheet.
 *
 * Units follow the chart kit (components/charts/core/types.ts): money = integer cents,
 * percent = FRACTION (0.131 = 13.1%), a missing value is `null` (a gap, never 0).
 * The metric registry presents percent ×100; `lib/fpna/workspace/units.ts` converts once.
 *
 * Every chart block carries the arrays it draws; the client builds View-as-table / CSV /
 * XLSX from those same arrays (AC-W8), never from a second query.
 */

import type { MonthKey } from '@/lib/analytics/months';
import type { Basis, CannotComputeReason, ComparisonKind, MetricGroup, Requirement, Verdict } from '@/lib/metrics/types';

export type FpnaTab = 'dashboard' | 'performance' | 'budget' | 'bridges' | 'working-capital' | 'profitability' | 'group' | 'leverage';

export const FPNA_TABS: readonly FpnaTab[] = ['dashboard', 'performance', 'budget', 'bridges', 'working-capital', 'profitability', 'group', 'leverage'];

export const TAB_LABEL: Record<FpnaTab, string> = {
  dashboard: 'Dashboard',
  performance: 'Performance',
  budget: 'Budget vs actual',
  bridges: 'Bridges',
  'working-capital': 'Working capital',
  profitability: 'Profitability',
  group: 'Group',
  leverage: 'Leverage & covenants',
};

/** Chart-kit units (mirrors components/charts/core/types.ts — kept here so server code never imports the kit). */
export type WsUnit = 'money' | 'percent' | 'count' | 'ratio' | 'multiple' | 'days' | 'months';
export type WsDirection = 'higher_is_better' | 'lower_is_better' | 'neutral';
export type WsPeriodStatus = 'closed' | 'preliminary' | 'forecast';
export type WsValue = number | null;

export type Weighting = 'full' | 'ownership';

export interface WsPeriod {
  /** Period end month the metrics are evaluated at. */
  end: MonthKey;
  basis: Basis;
  comparison: ComparisonKind;
  /** First / last month of the current window. */
  from: MonthKey;
  to: MonthKey;
  /** "YTD Sep 2026", "Sep 2026", "TTM to Sep 2026", "Q3 2026 to date". */
  label: string;
  /** "vs the same period last year" (null for none). */
  comparisonLabel: string | null;
  fyStartMonth: number;
}

export interface WsCompany {
  id: string;
  name: string;
  /** Effective group ownership %, null = no ownership row (treated as 100%). */
  ownershipPct: number | null;
  closedThrough: MonthKey | null;
}

export interface WsGovernance {
  audience: 'finance' | 'non_finance';
  /** Earliest "books closed through" month over the companies in scope (HARD_CLOSE, from the period locks). */
  closedThrough: MonthKey | null;
  /** Non-finance: figures stop at the last month released for every company in scope. */
  releasedThrough: MonthKey | null;
  /** Finance sees months that are not closed / not released — labelled preview. */
  preview: boolean;
  /** Footer sentence ("Books closed through Aug 2026 · Sep 2026 is preliminary"). */
  footnote: string;
}

export interface WsEnvelope {
  tab: FpnaTab;
  period: WsPeriod;
  scope: { companies: WsCompany[]; weighting: Weighting; requested: string[] };
  governance: WsGovernance;
  generatedAt: string;
  /** Served from the per-(org, user, scope, period, epoch) cache. */
  cached: boolean;
  /** Ledger epoch the figures were computed at. */
  epoch: string;
}

// ── cards ────────────────────────────────────────────────────────────────────

export interface WsUnavailable {
  reason: CannotComputeReason;
  title: string;
  message: string;
}

export interface WsChange {
  /** Presentation delta: cents for money, FRACTION points for percent (0.023 = 2.3 pts). */
  delta: number;
  /** % change ×100 (null = n/m or a points metric). */
  pct: number | null;
  inPoints: boolean;
  verdict: Verdict;
  arrow: 'up' | 'down' | 'flat';
  sentence: string;
}

export interface WsSparkPoint {
  month: MonthKey;
  value: WsValue;
  preliminary: boolean;
}

export interface WsDrillTarget {
  /** The input (account class / sub-ledger key) this drill reads. */
  input: string;
  label: string;
  /** Presentation sign of Σ(debit − credit): −1 for credit-natured classes (revenue, liabilities). */
  sign: 1 | -1;
  statement: 'income_statement' | 'balance_sheet' | null;
  kind: 'gl_flow' | 'gl_balance' | 'budget' | 'operational' | 'concentration';
  accountIds: string[];
  source: string | null;
}

export interface CardModel {
  metric: string;
  name: string;
  group: MetricGroup;
  unit: WsUnit;
  direction: WsDirection;
  definition: string;
  formula: string;
  value: WsValue;
  comparison: { kind: Exclude<ComparisonKind, 'none'>; label: string; value: WsValue; unavailable: WsUnavailable | null; likeForLike: boolean } | null;
  change: WsChange | null;
  sparkline: WsSparkPoint[];
  /** The window each sparkline point covers ('month' for flow measures on a YTD / QTD / TTM card). */
  sparkBasis: Basis;
  /** Benchmark band tone (registry defaults, editable per tenant). */
  status: 'good' | 'watch' | 'poor' | null;
  benchmarkSource: string | null;
  unavailable: WsUnavailable | null;
  preliminary: boolean;
  notes: string[];
  window: { from: MonthKey; to: MonthKey; basis: Basis };
  drill: WsDrillTarget[];
  scope: { included: string[]; excluded: Array<{ companyId: string; name: string; message: string }> };
  /** Deterministic one-sentence summary (the card's alt text and an AI fact). */
  summary: string;
}

// ── chart blocks ──────────────────────────────────────────────────────────────

export interface WsChartPeriod {
  key: string;
  label: string;
  longLabel: string;
  status: WsPeriodStatus;
}

export interface WsTimeSeries {
  periods: WsChartPeriod[];
  actual: WsValue[];
  priorYear?: WsValue[];
  budget?: WsValue[];
  ttm?: WsValue[];
}

export type WsBlockState =
  | { kind: 'unavailable'; reason: 'not_enough_history' | 'not_on_file' | 'not_mapped' | 'not_meaningful' | 'no_approved_budget' | 'no_activity'; detail: string }
  | { kind: 'empty'; title: string; body: string; actionHref?: string; actionLabel?: string };

export interface WsBlockBase {
  id: string;
  title: string;
  eyebrow: string;
  basis: string;
  period: string;
  summary: string;
  definition?: { text: string; formula?: string; source?: string };
  footnotes: string[];
  state?: WsBlockState;
}

export interface WsSeriesBlock extends WsBlockBase {
  kind: 'series';
  metric: string;
  unit: WsUnit;
  direction: WsDirection;
  chart: 'combo' | 'line';
  data: WsTimeSeries;
  /** Headline figure for the latest month (or the window). */
  headline?: { value: WsValue; label: string; base: WsValue; baseLabel: string };
  /** Σ(debit − credit) of these accounts × sign reproduces the month's value. */
  drill?: { accountIds: string[]; statement: 'income_statement' | 'balance_sheet'; sign: 1 | -1 };
}

/** Several lines on one axis (margins, working-capital days). */
export interface WsMultiLineBlock extends WsBlockBase {
  kind: 'multi_line';
  unit: WsUnit;
  periods: WsChartPeriod[];
  lines: Array<{ key: string; label: string; metric: string; direction: WsDirection; values: WsValue[] }>;
  /** Alternate basis already computed (Margins: month ↔ TTM switch without a refetch). */
  alternates?: Record<string, Array<{ key: string; values: WsValue[] }>>;
}

export interface WsYoyCell {
  current: WsValue;
  prior: WsValue;
  change: WsValue;
  /** % change ×100 for dollar rows; null = n/m. */
  pct: WsValue;
  /** Points ×1 (e.g. 2.3) for margin rows. */
  points: WsValue;
}

export interface WsYoyBlock extends WsBlockBase {
  kind: 'yoy';
  rows: Array<{ key: string; label: string; unit: 'money' | 'percent'; direction: WsDirection; month: WsYoyCell; fytd: WsYoyCell; ttm: WsYoyCell }>;
  headings: { month: string; fytd: string; ttm: string };
}

export interface WsCagrBlock extends WsBlockBase {
  kind: 'cagr';
  rows: Array<{ key: string; label: string; rungs: Array<{ years: number; metric: string; value: WsValue; unavailable: WsUnavailable | null }> }>;
}

export interface WsSeasonalityBlock extends WsBlockBase {
  kind: 'seasonality';
  /** Calendar months Jan…Dec: index (1.00 = average month) and this fiscal year's ratio. */
  months: Array<{ key: string; label: string; index: WsValue; current: WsValue }>;
  quarterShares: WsValue[];
  yearsUsed: number[];
  best: { month: MonthKey; value: number } | null;
  worst: { month: MonthKey; value: number } | null;
}

export interface WsVarianceRow {
  key: string;
  label: string;
  actual: WsValue;
  plan: WsValue;
  direction: WsDirection;
  material: boolean;
  /** Accounts behind the row (engine drill). */
  accountIds?: string[];
}

export interface WsVarianceBlock extends WsBlockBase {
  kind: 'variance';
  unit: WsUnit;
  planLabel: string;
  rows: WsVarianceRow[];
  totals?: { actual: number; plan: number; variance: number; favourable: boolean };
  drillRange?: { from: string; to: string; companyIds: string[] };
}

export interface WsBridgeStep {
  key: string;
  label: string;
  kind: 'start' | 'delta' | 'subtotal' | 'end';
  value: number;
  residual?: boolean;
}

export interface WsBridgeBlock extends WsBlockBase {
  kind: 'bridge';
  unit: 'money';
  steps: WsBridgeStep[];
  ties: boolean;
  from: { label: string; window: string };
  to: { label: string; window: string };
}

export interface WsAgingBlock extends WsBlockBase {
  kind: 'aging';
  buckets: Array<{ key: string; label: string }>;
  rows: Array<{ key: string; label: string; sub?: string; values: WsValue[] }>;
}

export interface WsShareBlock extends WsBlockBase {
  kind: 'share';
  unit: WsUnit;
  itemLabel: string;
  items: Array<{ key: string; label: string; value: WsValue }>;
  threshold?: number;
}

export interface WsLeagueColumn {
  key: string;
  label: string;
  unit: WsUnit;
  direction: WsDirection;
}

export interface WsLeagueRow {
  key: string;
  label: string;
  sub?: string;
  values: WsValue[];
  /** Why a value is missing, per column (null when present). */
  reasons: Array<string | null>;
  spark: WsValue[];
  sparkStatuses: WsPeriodStatus[];
  href?: string;
}

export interface WsLeagueBlock extends WsBlockBase {
  kind: 'league';
  rowHeading: string;
  columns: WsLeagueColumn[];
  rows: WsLeagueRow[];
  sparkLabel: string;
  sparkUnit: WsUnit;
  sparkPeriods: string[];
  /** Sum row (money columns only; ratios are recomputed, never averaged). */
  total?: { label: string; values: WsValue[] };
}

export interface WsScatterBlock extends WsBlockBase {
  kind: 'scatter';
  xLabel: string;
  yLabel: string;
  xUnit: WsUnit;
  yUnit: WsUnit;
  sumLine: number | null;
  points: Array<{ key: string; label: string; x: WsValue; y: WsValue; size?: WsValue }>;
  notPlaced: string[];
}

export interface WsHeatBlock extends WsBlockBase {
  kind: 'heat';
  rowHeading: string;
  columns: WsLeagueColumn[];
  rows: Array<{ key: string; label: string; sub?: string; values: WsValue[] }>;
}

export interface WsGaugeBlock extends WsBlockBase {
  kind: 'gauges';
  gauges: Array<{
    key: string;
    label: string;
    sub: string;
    value: WsValue;
    threshold: number;
    thresholdKind: 'max' | 'min';
    unit: WsUnit;
    watch?: number;
    projected: WsValue;
    projectedLabel?: string;
    band: 'PASS' | 'WARN' | 'BREACH' | 'UNKNOWN';
    headroomPct: WsValue;
    breachDate: string | null;
  }>;
}

export interface WsTilesBlock extends WsBlockBase {
  kind: 'tiles';
  tiles: Array<{ key: string; label: string; value: WsValue; unit: WsUnit; sub: string }>;
}

export type WsBlock =
  | WsSeriesBlock
  | WsMultiLineBlock
  | WsYoyBlock
  | WsCagrBlock
  | WsSeasonalityBlock
  | WsVarianceBlock
  | WsBridgeBlock
  | WsAgingBlock
  | WsShareBlock
  | WsLeagueBlock
  | WsScatterBlock
  | WsHeatBlock
  | WsGaugeBlock
  | WsTilesBlock;

// ── responses ───────────────────────────────────────────────────────────────

export interface DashboardViewResponse extends WsEnvelope {
  tab: 'dashboard';
  dashboard: EffectiveDashboardSummary;
  cards: CardModel[];
}

export interface BlocksViewResponse extends WsEnvelope {
  blocks: WsBlock[];
  /** Tab-level notes (e.g. "No approved budget for FY 2026"). */
  notices: Array<{ tone: 'info' | 'warn'; title: string; body: string; href?: string; hrefLabel?: string }>;
}

export type ViewResponse = DashboardViewResponse | BlocksViewResponse;

// ── dashboards ──────────────────────────────────────────────────────────────

export type PackKey = 'owner' | 'cfo' | 'construction' | 'dealer' | 'practice' | 'custom';
export type LockLevel = 'unlocked' | 'add_move' | 'locked';
export type PublishMode = 'new_users' | 'override';
export type CardSize = 's' | 'm' | 'l';

export interface DashboardCard {
  metric: string;
  size: CardSize;
}

export interface DashboardSettings {
  basis: Basis;
  comparison: ComparisonKind;
  sparkline: 12 | 24;
}

export interface DashboardRow {
  id: string;
  scopeKind: 'tenant' | 'user';
  roleKey: string | null;
  userId: string | null;
  name: string;
  packKey: PackKey;
  cards: DashboardCard[];
  settings: DashboardSettings;
  lockLevel: LockLevel;
  requiredMetrics: string[];
  publishMode: PublishMode;
  version: number;
  isCurrent: boolean;
  basedOnId: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DashboardSource = 'personal' | 'role_default' | 'tenant_default' | 'pack';

export interface EffectiveDashboardSummary {
  /** Row id (personal or tenant), or null for a built-in pack. */
  id: string | null;
  /** 'pack:<key>' for built-in packs, else the row id. */
  ref: string;
  name: string;
  packKey: PackKey;
  cards: DashboardCard[];
  settings: DashboardSettings;
  source: DashboardSource;
  lock: { level: LockLevel; requiredMetrics: string[]; publishedBy: string | null; publishedAt: string | null; note: string | null; roleKey: string | null } | null;
  /** May the reader save a personal copy (unlocked / add_move)? */
  canPersonalize: boolean;
  /** The reader's personal copy was superseded by an `override` publish. */
  overridden: boolean;
  version: number;
}

export interface DashboardListResponse {
  effective: EffectiveDashboardSummary;
  personal: Array<{ id: string; name: string; packKey: PackKey; updatedAt: string; cardCount: number }>;
  tenant: Array<{ id: string; roleKey: string | null; name: string; version: number; lockLevel: LockLevel; publishMode: PublishMode; publishedBy: string | null; publishedAt: string | null; cardCount: number }>;
  packs: Array<{ key: PackKey; name: string; description: string; cardCount: number }>;
  role: string | null;
  canPublish: boolean;
}

// ── catalog ─────────────────────────────────────────────────────────────────

export interface CatalogEntry {
  key: string;
  name: string;
  group: MetricGroup;
  groupLabel: string;
  unit: WsUnit;
  direction: WsDirection;
  definition: string;
  formula: string;
  requires: Requirement[];
  requiresLabel: string[];
  /** Fixed window ('ttm' …) or 'request' (follows the dashboard). */
  basis: 'request' | Basis;
  audiences: string[];
  hasBenchmark: boolean;
}
