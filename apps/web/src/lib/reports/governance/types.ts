/**
 * NUMBER GOVERNANCE — the typed contract (Wave 3D, FPB-tenant-model-consolidation-analytics §18).
 *
 * The report engine (3A) and the metric registry (3B) call `applyGovernance(view, ctx)`
 * (./apply.ts) before they return any figure, then drop whatever the decision does not show
 * (`filterByGovernance`, ./filter.ts). The pure core is `evaluateGovernance(input)`
 * (./policy.ts) over pre-loaded `GovernanceFacts` (./load.ts).
 *
 * PURE: types only. Safe to import from server or client code.
 */

/** 'YYYY-MM' — a calendar month (fiscal_periods are calendar months; FY start is a label). */
export type PeriodKey = string;

export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';
/** A company with no fiscal_periods row for the month reports NO_PERIOD. */
export type CloseStatus = PeriodStatus | 'NO_PERIOD';

/**
 * Who is reading. `finance` sees unreleased months as preview; everyone else sees only
 * released months. Resolved SERVER-SIDE from capabilities (./audience.ts) — never from input.
 */
export type GovernanceAudience = 'finance' | 'non_finance';

export type ScopeKind = 'company' | 'combined' | 'consolidated';

export type PeriodVisibility = 'visible' | 'preview' | 'hidden';

export type HiddenReason =
  | 'not_released' //    non-finance (or finance with preview off) and not released
  | 'pre_acquisition' // every requested company is outside its in-group window that month
  | 'out_of_scope' //    no requested company is readable by the caller (client scope / other org)
  | 'no_companies'; //   nothing requested

/** none = every visible month is hard-closed and released; preliminary = a visible month is
 *  not hard-closed; preview = an unreleased month is shown (finance only). */
export type WatermarkMode = 'none' | 'preliminary' | 'preview';

export type ReleaseMode = 'MANUAL' | 'AUTO';

// ── Facts (what the loader reads) ──────────────────────────────────────────────

export interface FiscalPeriodFact {
  /** fiscal_periods.id (absent in hand-built test facts). */
  id?: string;
  year: number;
  month: number;
  status: PeriodStatus;
  /** ISO date (fiscal_periods.end_date). */
  endDate: string;
  closedAt: string | null;
  reopenReason: string | null;
}

export interface ReleaseFact {
  id: string;
  year: number;
  month: number;
  status: 'RELEASED' | 'WITHDRAWN';
  mode: ReleaseMode;
  releasedAt: string | null;
  releasedBy: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
  baselineSnapshotId: string | null;
}

export interface RestatementFact {
  id: string;
  year: number;
  month: number;
  detectedAt: string;
  netIncomeDeltaCents: number;
  acknowledged: boolean;
}

export interface CoverageFact {
  /** ISO date; the company is in the group from this date's MONTH. */
  inGroupFrom: string | null;
  inGroupUntil: string | null;
}

export interface ReleaseSettings {
  autoReleaseEnabled: boolean;
  /** Days after month end. */
  autoReleaseDays: number;
  autoReleaseMinStatus: 'SOFT_CLOSE' | 'HARD_CLOSE';
  deadlines: DeadlineDef[];
}

export interface DeadlineDef {
  key: string;
  label: string;
  cadence: 'monthly' | 'quarterly' | 'annual';
  daysAfterPeriodEnd: number;
  recipient?: string | null;
}

export interface CompanyFacts {
  locationId: string;
  name: string;
  /** First month of the fiscal year (core.locations.fiscal_year_start_month), 1..12. */
  fiscalYearStartMonth: number;
  periods: FiscalPeriodFact[];
  releases: ReleaseFact[];
  restatements: RestatementFact[];
  coverage: CoverageFact | null;
  /** Effective rule (company override ?? tenant ?? defaults). */
  settings: ReleaseSettings;
}

export interface GovernanceFacts {
  /** Companies the CALLER can read (RLS + client scope), keyed by location id. */
  companies: Record<string, CompanyFacts>;
  tenantSettings: ReleaseSettings;
  /** Companies with their own release-rule row (override of the tenant rule). */
  companyOverrides?: string[];
}

// ── Request + decision ─────────────────────────────────────────────────────────

export interface GovernanceView {
  /** Requested months, any order; normalized ascending. */
  periods: PeriodKey[];
  /** Requested companies (already resolved by the scope engine for a group). */
  locationIds: string[];
  scopeKind: ScopeKind;
}

export interface GovernanceOptions {
  /** Finance only: show unreleased months as preview. Default true for finance. */
  includePreview?: boolean;
  /** Finance only: include months outside the in-group window. Default false. */
  proForma?: boolean;
}

export interface GovernanceInput {
  view: GovernanceView;
  facts: GovernanceFacts;
  audience: GovernanceAudience;
  options?: GovernanceOptions;
  /** ISO date 'YYYY-MM-DD' (today, tenant-local). */
  today: string;
}

export interface CompanyReleaseState {
  released: boolean;
  mode: ReleaseMode | null;
  /** Explicit release time, or the derived auto-release date. */
  releasedOn: string | null;
  /** True when released by the auto rule but not yet materialized as a row. */
  derived: boolean;
  withdrawn: boolean;
  /** When the auto rule will release it (if it would, once its conditions hold). */
  autoReleaseOn: string | null;
  /** Why it cannot be released yet (null when releasable or released). */
  blockedBy: 'not_ended' | 'no_period' | 'open' | 'soft_close_below_minimum' | null;
  /**
   * Released on its own, but an earlier month (with a fiscal period) is not released, so it
   * does not count yet — releases are IN ORDER. The first such earlier month.
   */
  heldBy?: PeriodKey | null;
}

export interface CompanyPeriodDecision {
  locationId: string;
  visibility: PeriodVisibility | 'excluded' | 'out_of_scope';
  closeStatus: CloseStatus;
  release: CompanyReleaseState;
  inGroup: boolean;
  /** Latest restatement date for this company-month (ISO), or null. */
  restatedOn: string | null;
  restatementCount: number;
}

export interface PeriodDecision {
  key: PeriodKey;
  year: number;
  month: number;
  visibility: PeriodVisibility;
  hiddenReason: HiddenReason | null;
  /** Worst close status among the included companies. */
  closeStatus: CloseStatus;
  unclosed: boolean;
  /** Every included company is released. */
  released: boolean;
  restatedOn: string | null;
  proForma: boolean;
  companies: CompanyPeriodDecision[];
}

export type AnnotationKind =
  | 'closed_through'
  | 'released_through'
  | 'unclosed'
  | 'restated'
  | 'preview'
  | 'hidden_unreleased'
  | 'pre_acquisition'
  | 'pro_forma'
  | 'out_of_scope';

export interface GovernanceAnnotation {
  kind: AnnotationKind;
  text: string;
  periodKey?: PeriodKey;
  locationId?: string;
}

export interface GovernanceDecision {
  audience: GovernanceAudience;
  includePreview: boolean;
  proForma: boolean;
  periods: PeriodDecision[];
  /** Months whose figures may be returned (visible + preview), ascending. */
  shownPeriodKeys: PeriodKey[];
  /** For each shown month, the companies whose figures may be summed. Hidden months → []. */
  locationsByPeriod: Record<PeriodKey, string[]>;
  /** Requested companies the caller cannot read — never contribute. */
  outOfScopeLocationIds: string[];
  closedThrough: { scope: PeriodKey | null; byCompany: Record<string, PeriodKey | null> };
  releasedThrough: { scope: PeriodKey | null; byCompany: Record<string, PeriodKey | null> };
  watermark: WatermarkMode;
  banner: { tone: 'warn'; text: string } | null;
  annotations: GovernanceAnnotation[];
  /** Deterministic one-to-two sentence footnote for report headers and chart footers. */
  footnote: string;
}

export const DEFAULT_RELEASE_SETTINGS: ReleaseSettings = {
  autoReleaseEnabled: false,
  autoReleaseDays: 20,
  autoReleaseMinStatus: 'HARD_CLOSE',
  deadlines: [],
};
