/**
 * COMMISSIONS — types for the pure calculation engine (docs/FPB-commissions.md).
 *
 * Owner decision (c): payroll includes a commissions mechanism that works with ANY
 * payroll system. Books CALCULATES commission earnings (HVAC tech commissions on
 * sold / installed jobs, sales commissions, spiffs), a manager APPROVES them, they
 * are ACCRUED in the GL at period end, and they are HANDED to the payroll provider
 * as earnings (lib/payroll/providers — API push or earnings CSV).
 *
 * NOT the retired workforce engine (CANON §2): no chargebacks, no burden/overhead
 * rate, no labor classifications. Commissions are an employee EARNING, computed
 * from revenue / gross-profit events, nothing else.
 *
 * Money: integer cents. Rates: integer BASIS POINTS (1 bp = 0.01%; 500 = 5%;
 * 10_000 = 100%) so no float ever touches money.
 */

/** How the plan turns a basis into a commission. */
export type CommissionPlanKind =
  | 'PERCENT_REVENUE' // rateBps × revenue
  | 'PERCENT_GROSS_PROFIT' // rateBps × (revenue − cost)
  | 'FLAT_PER_JOB' // flatCents per qualifying job
  | 'TIERED' // period total measured against tiers (range bonus / accelerator)
  | 'SPIFF'; // flatCents per qualifying unit of specific items

/**
 * WHEN a source line becomes commissionable:
 *   SOLD      — the job/estimate was sold (signed)          → earliest, most clawback risk
 *   INSTALLED — the work was completed / installed
 *   INVOICED  — the invoice posted                            (ServiceTitan default)
 *   PAID      — cash collected; earned pro-rata to cash        (RFMS GP default)
 */
export type CommissionBasisEvent = 'SOLD' | 'INSTALLED' | 'INVOICED' | 'PAID';

/** What a TIERED plan measures. */
export type TierMeasure = 'REVENUE' | 'GROSS_PROFIT';

/**
 * MARGINAL     — each slice earns its own tier's rate (tax-bracket style).
 * RETROACTIVE  — the whole amount earns the rate of the highest tier reached.
 */
export type TierMode = 'MARGINAL' | 'RETROACTIVE';

export interface CommissionTier {
  /** Inclusive lower bound of the tier, cents. The first tier must start at 0. */
  fromCents: number;
  rateBps: number;
}

export interface ClawbackPolicy {
  /** Reverse commission when the job/invoice is cancelled or voided. */
  onCancellation: boolean;
  /** Reverse commission on refunds / credit memos, pro-rata to the refunded share. */
  onRefund: boolean;
  /**
   * Reverse commission when the invoice is still unpaid this many days after its
   * due date (null = never). Re-earned automatically if the customer later pays.
   */
  unpaidAfterDays: number | null;
  /** Only claw back within this many days of the commission being earned (null = no limit). */
  windowDays: number | null;
}

export interface CommissionPlan {
  id: string;
  name: string;
  kind: CommissionPlanKind;
  basisEvent: CommissionBasisEvent;
  /** PERCENT_* plans. */
  rateBps?: number;
  /** FLAT_PER_JOB (per job) / SPIFF (per unit). */
  flatCents?: number;
  /** TIERED plans. Sorted ascending by fromCents; first must be 0. */
  tiers?: CommissionTier[];
  tierMode?: TierMode;
  tierMeasure?: TierMeasure;
  /** SPIFF plans: item codes that qualify (case-insensitive). */
  spiffItemCodes?: string[];
  /** No commission on a line whose gross margin is below this (bps of revenue). */
  minMarginBps?: number | null;
  /** Cap per source line (cents). */
  capPerLineCents?: number | null;
  clawback: ClawbackPolicy;
  /** GL classification of the expense: direct (tech, job cost) vs selling. */
  expenseClass: 'COGS' | 'OPEX';
}

/**
 * One commissionable source fact for one employee: a job, an invoice, or an
 * invoice line, already joined to its revenue / cost / lifecycle dates by the
 * loader. `splitBps` is this employee's share (two techs at 50/50 → 5_000 each).
 */
export interface CommissionSource {
  sourceType: 'JOB' | 'INVOICE' | 'INVOICE_LINE' | 'EXTERNAL';
  sourceId: string;
  employeeId: string;
  splitBps: number;
  /** Net revenue on the source (after discounts, before tax), cents. */
  revenueCents: number;
  /** Job cost (materials + labor + subs) for gross-profit plans, cents. */
  costCents: number;
  /** Units for SPIFF plans. */
  quantity: number;
  itemCode: string | null;
  soldOn: string | null;
  installedOn: string | null;
  invoicedOn: string | null;
  dueOn: string | null;
  /** Cash collected against the source, cents (drives PAID basis). */
  paidCents: number;
  /** Date the source became fully paid (or last payment date). */
  paidOn: string | null;
  cancelledOn: string | null;
  /** Refunds / credit memos against the source, cents. */
  refundedCents: number;
}

export type CommissionLineKind = 'EARNED' | 'CLAWBACK' | 'REINSTATED' | 'ADJUSTMENT';

/** A computed (proposed) commission line — becomes a commission_lines row on approval. */
export interface CommissionLine {
  planId: string;
  employeeId: string;
  sourceType: CommissionSource['sourceType'];
  sourceId: string;
  kind: CommissionLineKind;
  /** The cents the rate was applied to (after split), for audit. */
  basisCents: number;
  /** Effective rate for audit (bps); 0 for flat amounts. */
  rateBps: number;
  /** Signed: positive earned, negative clawback. */
  amountCents: number;
  /** ISO date the line is recognized (drives the period it lands in). */
  recognizedOn: string;
  /** Plain-English why, shown on the employee statement. */
  explanation: string;
}
