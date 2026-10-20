/**
 * The Autonomy Capability Catalog (M10) — the real, enumerated list of every AI
 * capability the control plane governs. Each entry maps a live `ai_decisions.feature`
 * key (the exact string the detectors/proposers write) to a human label, plain
 * description, category, and a most-conservative default dial.
 *
 * The keys here are NOT invented — they are the `*_FEATURE` constants exported by
 * the code that actually produces AI decisions (lib/services/* + lib/controls/*).
 * Keeping the canonical list in one place means the settings screen, the API, and
 * the disposition helper all agree on what "a feature" is.
 *
 * Canon §3: auto-post is OFF by default; autonomy is a per-tenant, per-task dial.
 * So every capability ships at the most-conservative dial — PROPOSE (detect/propose;
 * a human approves). An admin opts a capability up to AUTO_UNDER_LIMIT deliberately.
 */

import type { AutonomyMode } from './disposition';

export type AutonomyCategory = 'processing' | 'control';

export interface AutonomyFeatureDef {
  /** ai_decisions.feature key — the exact string the producing code writes. */
  feature: string;
  label: string;
  description: string;
  category: AutonomyCategory;
  /** Ships at the most-conservative dial (canon §3). */
  defaultMode: AutonomyMode;
}

/**
 * The governed capabilities. `processing` = AI that eliminates manual data entry
 * (proposes ledger facts a human/engine applies). `control` = detect-only financial
 * control exceptions that surface into /exceptions and never move money.
 */
export const AUTONOMY_FEATURES: readonly AutonomyFeatureDef[] = [
  // ── Processing / data-entry AI (pillar 2) ──────────────────────────────────
  {
    feature: 'CATEGORIZATION',
    label: 'Bank feed categorization',
    description:
      'Proposes the GL account + dimensions for each bank-feed transaction. High-confidence, low-dollar categorizations can auto-apply when the dial permits.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'BILL_PARSE',
    label: 'Bill / invoice intake (AP)',
    description:
      'Reads an uploaded bill and drafts the vendor, amounts, dates, and coding for an AP bill.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'JE_COMPOSER',
    label: 'Journal entry composer',
    description:
      'Drafts a balanced journal entry from a natural-language or document prompt for a human to review and post.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'CASH_APPLICATION',
    label: 'Cash application (AR)',
    description:
      'Matches incoming customer payments to open invoices and proposes the application.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'RECON_ADJUSTMENT',
    label: 'Reconciliation adjusting entries',
    description:
      'Drafts categorized adjusting entries (bank fees, interest, NSF, FX/rounding) for unmatched bank lines so a reconciliation ties. Proposes only; a human approves and posts. An unexplained residual is never plugged.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'EXCEPTION_PREDICTION',
    label: 'Exception resolution assistant',
    description:
      'Predicts the likely resolution for an item in the exception queue to speed a human decision.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },

  // ── Scheduled engines (lib/scheduler/posting-gate.ts) ──────────────────────
  // Deterministic engines the scheduler (M-12) runs on a cadence. At PROPOSE they
  // only compute a preview (a human runs the posting from the module screen); at
  // AUTO_UNDER_LIMIT the scheduled run posts when the run total is ≤ the cap.
  {
    feature: 'SCHEDULED_REV_REC',
    label: 'Scheduled revenue recognition (1st of month)',
    description:
      'On the 1st, previews the monthly rev-rec run for every eligible job. At Propose a human posts it from Revenue recognition; at Auto-under-limit the scheduled run posts when the total recognized is within the cap.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'SCHEDULED_PREPAID_AMORTIZATION',
    label: 'Scheduled prepaid amortization',
    description:
      'Monthly, finds every due prepaid amortization period. At Propose it reports what is due for a human to post; at Auto-under-limit the scheduled run posts when the total is within the cap.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'SCHEDULED_EVENT_DRAIN',
    label: 'Scheduled Projects event drain',
    description:
      'Hourly, checks for pending Projects events (job billing, internal invoices, progress). At Propose they wait for a human to process them; at Auto-under-limit billing and internal-invoice events post when the pending total is within the cap. Progress (rev-rec) events always wait for a human because their amount is unknown until recognized.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },

  // ── Financial control exceptions (detect-only) ─────────────────────────────
  {
    feature: 'DUPLICATE_PAYMENT',
    label: 'Duplicate payment / vendor (EC-1)',
    description:
      'Scans AP for duplicate bills, double payments, and near-duplicate vendor masters that fragment spend.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'MISSED_ACCRUAL',
    label: 'Missed accrual / deferral (EC-2)',
    description:
      'Finds recurring economic activity that should be accrued at period end but has not been.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'INTERCOMPANY_IMBALANCE',
    label: 'Intercompany imbalance (EC-3)',
    description:
      'Detects intercompany balances that do not net to zero across entities before consolidation.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'UNCATEGORIZED_LEAKAGE',
    label: 'Uncategorized leakage (EC-4)',
    description:
      'Surfaces spend sitting in suspense / uncategorized accounts that is leaking out of the P&L.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'REVENUE_NOT_RECOGNIZED',
    label: 'Revenue not recognized (EC-6)',
    description:
      'Flags deferred revenue that has met its recognition trigger but has not been recognized.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'SALES_TAX_NEXUS',
    label: 'Sales-tax nexus (EC-7)',
    description:
      'Watches for sales into jurisdictions where an economic-nexus threshold may have been crossed.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'ANOMALOUS_JE',
    label: 'Anomalous journal entry (EC-10)',
    description:
      'Detects journal entries that are statistical outliers in amount, timing, account pairing, or author.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'CUTOFF_ERROR',
    label: 'Period cutoff error (EC-12)',
    description:
      'Finds transactions booked on the wrong side of a period boundary (revenue/expense cutoff).',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'BILL_ANOMALY',
    label: 'Bill anomaly',
    description:
      'Detects bills that deviate from a vendor’s established amount/frequency pattern.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'OUT_OF_POLICY_EXPENSE',
    label: 'Out-of-policy expense (EC-14)',
    description:
      'Re-checks submitted/approved/reimbursed employee expense reports against the active compiled expense policy and flags any that still breach a WARN/BLOCK rule — the "approved out of policy anyway" catch.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  // ── Dealer pack (industry module; FPB-dealer-pack §5–6) ─────────────────────
  {
    feature: 'DEALER_FLOORING',
    label: 'Dealer: floor a unit',
    description:
      'Proposes the floor-plan note and journal entry when a financed unit arrives from the manufacturer invoice or lender statement.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_INTEREST_ACCRUAL',
    label: 'Dealer: floor-plan interest accrual',
    description:
      'Month-end accrual of floor-plan interest per unit and the true-up to the lender statement. Posts only when this dial allows.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_OEM_CREDIT_MATCH',
    label: 'Dealer: match manufacturer credits',
    description:
      'Matches credits on manufacturer statements to open warranty claims and incentive claims, with confidence and reasoning.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_LENDER_STATEMENT_PARSE',
    label: 'Dealer: read lender statements',
    description:
      'Reads a floor-plan lender statement or audit report into lines for reconciliation (proposals only).',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_OEM_STATEMENT_PARSE',
    label: 'Dealer: read manufacturer statements',
    description:
      'Reads a manufacturer parts/warranty statement or credit memo into lines (proposals only).',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_DEAL_RECAP_PARSE',
    label: 'Dealer: read deal recaps',
    description:
      'Reads a dealer-system deal recap (unit sale, trade, rebates, tax) into a proposed deal.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_UNIT_LIST_PARSE',
    label: 'Dealer: read unit lists',
    description:
      'Reads a stock/unit list export from the dealer system into proposed unit records.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_PROGRAM_PARSE',
    label: 'Dealer: read incentive programs',
    description:
      'Reads a manufacturer incentive or floor-plan program bulletin into a proposed program.',
    category: 'processing',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_SOT',
    label: 'Dealer: sold out of trust',
    description:
      'A unit was sold (in Books, the dealer system, or a warranty registration) but its floor-plan note is still open past the payoff window.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_CURTAILMENT',
    label: 'Dealer: curtailment due or missed',
    description:
      'A scheduled floor-plan curtailment is coming due or was missed.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_FLOOR_MISMATCH',
    label: 'Dealer: floor plan vs units mismatch',
    description:
      "A floor-plan note has no matching unit in stock, or a floored unit has no note — or the subledger doesn't tie to the GL.",
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_AGED_UNIT',
    label: 'Dealer: aged units',
    description:
      'Units in stock past the aging threshold (interest-bearing or near maximum term).',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_WARRANTY',
    label: 'Dealer: warranty claim aging',
    description:
      'Warranty claims unpaid past the aging threshold, short-paid, or rejected above the normal rate.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_INCENTIVE',
    label: 'Dealer: incentive receivable aging',
    description:
      'Manufacturer rebates, co-op or other incentives owed to the dealer and unpaid past the threshold.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_STATEMENT_VARIANCE',
    label: 'Dealer: lender statement variance',
    description:
      'The lender statement and the Books floor-plan balances disagree beyond tolerance.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_LINE_UTILIZATION',
    label: 'Dealer: credit line near limit',
    description:
      'A floor-plan line is close to (or over) its approved limit.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_TRADE_RISK',
    label: 'Dealer: trade-in risk',
    description:
      'A trade-in was allowed well above its appraised value, or a lien payoff is outstanding.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_DEMO_ON_FLOOR',
    label: 'Dealer: demo or rental still floored',
    description:
      'A unit used as a demo or rental is still on floor plan (lenders usually require payoff or curtailment).',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
  {
    feature: 'DEALER_DOUBLE_FLOORING',
    label: 'Dealer: possible double flooring',
    description:
      'The same serial number appears on more than one floor-plan note.',
    category: 'control',
    defaultMode: 'PROPOSE',
  },
] as const;

/** Fast lookup by feature key. */
export const AUTONOMY_FEATURE_MAP: Readonly<Record<string, AutonomyFeatureDef>> =
  Object.fromEntries(AUTONOMY_FEATURES.map((f) => [f.feature, f]));

/** All governed feature keys (for validation). */
export const AUTONOMY_FEATURE_KEYS: readonly string[] = AUTONOMY_FEATURES.map(
  (f) => f.feature,
);

/** Whether a feature key is one the control plane governs. */
export function isGovernedFeature(feature: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUTONOMY_FEATURE_MAP, feature);
}
