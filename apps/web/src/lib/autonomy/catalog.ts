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
    feature: 'EXCEPTION_PREDICTION',
    label: 'Exception resolution assistant',
    description:
      'Predicts the likely resolution for an item in the exception queue to speed a human decision.',
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
