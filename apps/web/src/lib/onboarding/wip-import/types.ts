/**
 * Jobs / WIP onboarding import — shared types (PURE, isomorphic).
 *
 * The construction-critical capture: a homebuilder brings in their OPEN jobs so the
 * opening WIP position (costs-to-date, earned-but-unbilled, billed-in-excess,
 * retainage) TIES to the GL on day one. This is the piece QuickBooks does not hold.
 *
 * A `ProposedJob` is the drop-and-parse proposal shape (mirrors `ProposedLoan` in
 * lib/debt/parse-loan.ts): every field carries a confidence and undeterminable
 * fields are left null for the human — never guessed. ALL MONEY IS INTEGER CENTS
 * (the CSV path coerces dollars→cents; the AI path converts whole dollars→cents in
 * the normalizer), so the opening-WIP math and the conversion `subledgerDetail`
 * totals are cents end-to-end.
 */

import type { ProposalSource } from '@/components/onboarding/helpers';

/** One cost-code budget line for a job (budget / EAC by cost code). Cents. */
export interface ProposedCostCode {
  /** Cost code as it appears in the source (e.g. "01-100", "LABOR"). */
  code: string;
  /** Human label / description, when present. */
  label: string | null;
  /** Cost-type bucket, mapped to the job's budget columns. */
  costType: JobCostType | null;
  /** Budgeted (estimated total) cost for this code, cents. */
  budgetCents: number;
}

/** The four+ cost buckets core.jobs carries (budget_/actual_ columns). */
export type JobCostType = 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER';

/**
 * A proposed OPEN job mapped onto core.jobs. Money is cents; a field the source did
 * not state is null (for the human to complete) — never invented.
 */
export interface ProposedJob {
  jobNumber: string;
  jobName: string;
  customerName: string | null;
  /** Optional industry tag (CONSTRUCTION/HVAC/…); defaults to CONSTRUCTION on commit. */
  jobType: string | null;

  /** Original contract value BEFORE change orders, cents. Null if not stated. */
  originalContractCents: number | null;
  /** Approved change orders (running total), cents. Null if not stated. */
  approvedChangeOrdersCents: number | null;
  /**
   * Current contract value INCLUDING approved COs, cents, when the source states it
   * directly. When null, the effective contract is derived as original + COs
   * (see `effectiveContractCents`).
   */
  contractValueCents: number | null;

  /** Estimated total cost at completion (EAC baseline), cents. Null if not stated. */
  estimatedCostCents: number | null;
  /** Actual cost incurred to date, cents. Null if not stated. */
  costsToDateCents: number | null;
  /** Amount billed to the customer to date, cents. Null if not stated. */
  billedToDateCents: number | null;

  /** Retainage receivable — held back on OUR billings (contract asset), cents. */
  retainageReceivableCents: number | null;
  /** Retainage payable — held back from subs (liability), cents. */
  retainagePayableCents: number | null;
  /** Customer deposits/advances — a LIABILITY, never revenue, cents. */
  customerDepositsCents: number | null;

  /** Physical %-complete as a FRACTION [0,1]; null ⇒ cost-to-cost is used. */
  pctCompleteOverride: number | null;

  /** Budget / EAC by cost code, when the source breaks it out. */
  costCodes: ProposedCostCode[];

  /** Per-field confidence 0..1 (AI) or 1 (deterministic CSV column-map). */
  confidence: Record<string, number>;
  /** Fields left blank or below the confidence floor — surfaced for the human. */
  lowConfidenceFields: string[];
  /** Where the proposal came from (drives the ProposalCard band). */
  source: ProposalSource;
  /** Short verbatim excerpt (AI path) for traceability. */
  snippet?: string | null;
}

/** The WIP section's staged proposal — the set of open jobs + the as-of date. */
export interface WipProposal {
  jobs: ProposedJob[];
  /** Opening-balance as-of date (ISO), when the caller has it. */
  asOfDate?: string | null;
}

/** The opening WIP subledger totals that must tie to the GL control accounts. */
export interface OpeningWipTotals {
  jobs: number;
  contractValueCents: number;
  estimatedCostCents: number;
  /** Σ costs-to-date → JOB_WIP asset. */
  costsToDateCents: number;
  /** Σ earned revenue (POC), cents. */
  earnedRevenueCents: number;
  billedToDateCents: number;
  /** Σ under-billings → UNBILLED_RECEIVABLE (1180) contract asset. */
  unbilledCents: number;
  /** Σ over-billings → DEFERRED_REVENUE (2410) contract liability. */
  billingsInExcessCents: number;
  /** Σ retainage receivable → RETAINAGE_RECEIVABLE. */
  retainageReceivableCents: number;
  /** Σ retainage payable → RETAINAGE_PAYABLE. */
  retainagePayableCents: number;
  /** Σ customer deposits → CUSTOMER_DEPOSITS liability (never revenue). */
  customerDepositsCents: number;
  overbilledJobs: number;
  underbilledJobs: number;
}
