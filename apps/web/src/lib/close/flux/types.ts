/**
 * Flux review (Wave 3E, FPB-financial-reports §5 / A-3E) — shared types.
 *
 * Pure type module: no runtime, safe to import from client components. All money is
 * integer cents; percentages are basis points (1000 = 10%) and `null` when the
 * comparison base is zero (never Infinity, never a made-up 100%).
 */

import type { AccountSubType, AccountType } from '@/lib/posting/account-direction';

export type ThresholdMode = 'EITHER' | 'BOTH' | 'ABS_ONLY' | 'PCT_ONLY';
export type ComparisonBasis = 'PRIOR_MONTH' | 'PRIOR_YEAR_MONTH' | 'BUDGET' | 'TRAILING_3_AVG';
export type FluxDimension = 'ACCOUNT' | 'ACCOUNT_DEPARTMENT' | 'ACCOUNT_CLASS';
export type OverrideScope = 'TYPE' | 'GROUP' | 'ACCOUNT';

export const THRESHOLD_MODES: readonly ThresholdMode[] = ['EITHER', 'BOTH', 'ABS_ONLY', 'PCT_ONLY'];
export const COMPARISON_BASES: readonly ComparisonBasis[] = ['PRIOR_MONTH', 'PRIOR_YEAR_MONTH', 'BUDGET', 'TRAILING_3_AVG'];
export const FLUX_DIMENSIONS: readonly FluxDimension[] = ['ACCOUNT', 'ACCOUNT_DEPARTMENT', 'ACCOUNT_CLASS'];

export const BASIS_LABEL: Record<ComparisonBasis, string> = {
  PRIOR_MONTH: 'Prior month',
  PRIOR_YEAR_MONTH: 'Same month last year',
  BUDGET: 'Budget',
  TRAILING_3_AVG: 'Trailing 3-month average',
};

export const MODE_LABEL: Record<ThresholdMode, string> = {
  EITHER: '$ or %',
  BOTH: '$ and %',
  ABS_ONLY: '$ only',
  PCT_ONLY: '% only',
};

export interface MaterialityOverride {
  scope: OverrideScope;
  /** TYPE: account type (e.g. 'OPEX'); GROUP: account_group_id; ACCOUNT: account_id. */
  key: string;
  absThresholdCents?: number | null;
  pctThresholdBps?: number | null;
  mode?: ThresholdMode | null;
  excluded?: boolean | null;
}

export interface FluxPolicy {
  /** null ⇒ the built-in default (no row stored). */
  id: string | null;
  /** Where it came from: the company row, the tenant default row, or the built-in default. */
  source: 'COMPANY' | 'TENANT' | 'DEFAULT';
  locationId: string | null;
  reviewRequired: boolean;
  thresholdMode: ThresholdMode;
  absThresholdCents: number;
  pctThresholdBps: number;
  comparisonBasis: ComparisonBasis;
  dimension: FluxDimension;
  includePnl: boolean;
  includeBalanceSheet: boolean;
  overrides: MaterialityOverride[];
  excludedAccountIds: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The threshold that applies to one account after override resolution. */
export interface ResolvedThreshold {
  mode: ThresholdMode;
  absThresholdCents: number;
  pctThresholdBps: number;
  excluded: boolean;
  /** Human-readable origin: "Policy", "Override: OPEX", "Override: account 6100". */
  source: string;
}

export interface FluxAccount {
  id: string;
  number: string;
  name: string;
  type: AccountType;
  subType: AccountSubType;
  groupId: string | null;
  groupName: string | null;
}

export type Statement = 'PNL' | 'BS';

export type FluxLineStatus = 'UNEXPLAINED' | 'DRAFT' | 'EXPLAINED' | 'REVIEWED' | 'STALE';

export type BreachReason = 'ABS' | 'PCT';

export interface FluxLine {
  /** account_id, or account_id|d:<department_id>, or account_id|c:<class_id>. */
  lineKey: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  groupName: string | null;
  statement: Statement;
  departmentId: string | null;
  classId: string | null;
  dimensionLabel: string | null;
  /** Normal-balance-signed amount this month (P&L activity / BS ending balance). */
  currentCents: number;
  comparisonCents: number;
  changeCents: number;
  /** change / |comparison| in bps, null when the comparison is 0. */
  changePctBps: number | null;
  /** The basis this line actually used (BUDGET falls back to PRIOR_MONTH for BS lines). */
  basisUsed: ComparisonBasis;
  threshold: ResolvedThreshold;
  material: boolean;
  breaches: BreachReason[];
  /** Oldest → newest, ending at the closing month (6 points). */
  trailing: { periodKey: string; cents: number }[];
}

export type DriverTag = 'LARGEST' | 'NEW_COUNTERPARTY' | 'ONE_OFF' | 'RECLASS';

export interface FluxDriver {
  /** Stable citation id ("L1", "L2", …) — the AI may cite only these. */
  ref: string;
  glEntryId: string;
  glLineId: string;
  entryNumber: string | null;
  entryDate: string;
  memo: string | null;
  sourceModule: string | null;
  counterparty: string | null;
  /** Normal-balance-signed effect on the line this month. */
  amountCents: number;
  tags: DriverTag[];
}

export interface CounterpartyDelta {
  counterparty: string;
  currentCents: number;
  comparisonCents: number;
  changeCents: number;
  isNew: boolean;
}

export interface FluxDrivers {
  lines: FluxDriver[];
  counterparties: CounterpartyDelta[];
  /** Σ of all current-month lines for this flux line (ties to currentCents for P&L lines). */
  activityCents: number;
  lineCount: number;
}

export type ExplanationCategory =
  | 'TIMING'
  | 'ONE_TIME'
  | 'VOLUME'
  | 'PRICE'
  | 'RECLASS'
  | 'ERROR_CORRECTED'
  | 'EXPECTED';

export const EXPLANATION_CATEGORIES: readonly ExplanationCategory[] = [
  'TIMING', 'ONE_TIME', 'VOLUME', 'PRICE', 'RECLASS', 'ERROR_CORRECTED', 'EXPECTED',
];

export const CATEGORY_LABEL: Record<ExplanationCategory, string> = {
  TIMING: 'Timing',
  ONE_TIME: 'One-time',
  VOLUME: 'Volume',
  PRICE: 'Price / rate',
  RECLASS: 'Reclass',
  ERROR_CORRECTED: 'Error corrected',
  EXPECTED: 'Expected / planned',
};

export type ExplanationStatus = 'DRAFT' | 'EXPLAINED' | 'REVIEWED';

export interface FluxExplanation {
  id: string;
  locationId: string;
  periodKey: string;
  lineKey: string;
  accountId: string;
  status: ExplanationStatus;
  explanation: string | null;
  category: ExplanationCategory | null;
  comparisonBasis: ComparisonBasis;
  currentCents: number;
  comparisonCents: number;
  changeCents: number;
  changePctBps: number | null;
  attachmentDocumentId: string | null;
  draftedByAi: boolean;
  aiDecisionId: string | null;
  carriedFromId: string | null;
  preparedBy: string | null;
  preparedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** sha256 of `category \n explanation` (server-computed) — what a reviewer approves. */
  explanationHash: string;
  /** The hash the sign-off pinned (REVIEWED only; equals explanationHash). */
  reviewedExplanationHash: string | null;
  updatedAt: string | null;
}

export interface CarryForwardSuggestion {
  fromId: string;
  periodKey: string;
  category: ExplanationCategory;
  explanation: string;
  /** Why it is offered: recurring category, or the same category in 2 of the last 3 months. */
  reason: string;
}

export interface FluxWaiver {
  status: 'OPEN' | 'WAIVED';
  reason: string | null;
  waivedBy: string | null;
  waivedAt: string | null;
}

/** One row on the Flux review screen. */
export interface FluxBoardLine extends FluxLine {
  status: FluxLineStatus;
  explanation: FluxExplanation | null;
  suggestion: CarryForwardSuggestion | null;
  drivers: FluxDrivers;
  /** The month the counterparty decomposition compares against. */
  driverComparisonPeriod: string;
}

export interface FluxBoardSummary {
  totalLines: number;
  material: number;
  unexplained: number;
  draft: number;
  explained: number;
  reviewed: number;
  stale: number;
  excluded: number;
}

export type FluxPeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';

export interface FluxBoard {
  period: { key: string; label: string; year: number; month: number; start: string; end: string };
  location: { id: string; name: string };
  fiscalPeriodId: string | null;
  periodStatus: FluxPeriodStatus;
  /** Explanations can be written (period not hard-closed). */
  editable: boolean;
  policy: FluxPolicy;
  lines: FluxBoardLine[];
  summary: FluxBoardSummary;
  gate: FluxCloseSignal;
  waiver: FluxWaiver | null;
  aiConfigured: boolean;
  /** Clerk id → display name (preparers / reviewers / waiver). */
  names: Record<string, string>;
  generatedAt: string;
}

/** What the close task graph sees (lib/close/orchestration.ts `flux_reviewed`). */
export interface FluxCloseSignal {
  applicable: boolean;
  status: 'NOT_REQUIRED' | 'NOTHING_MATERIAL' | 'COMPLETE' | 'WAIVED' | 'OPEN' | 'UNKNOWN';
  material: number;
  explained: number;
  reviewed: number;
  stale: number;
  unexplained: number;
  waiverReason: string | null;
}
