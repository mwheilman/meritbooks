/**
 * Book-to-tax difference engine — Schedule M-1 / M-3 reconciliation (TX-C1 / TX-C2).
 *
 * "The single richest AI opportunity" (AI-Capability-Matrix TX-C1; tax-compliance §1.3;
 * FPB EC-9). Book net income ≠ taxable income. This module is the PURE, deterministic,
 * I/O-free heart of the bridge: given a period's BOOK net income (in cents, computed the
 * SAME way the income-statement route computes it) plus the set of tagged book-tax
 * differences, it produces the Schedule M-1 reconciliation —
 *
 *     taxable income = book NI + additions − subtractions
 *
 * — with every difference classified PERMANENT vs TEMPORARY (the M-3 / ASC 740 split) on
 * its own labeled line. All arithmetic is integer-cents; there are no floats and no I/O,
 * so it is exhaustively unit-testable and never drifts from the ledger.
 *
 * Canon posture (§3): the AI proposes a TAG (which line an account/transaction belongs
 * to); it NEVER proposes a number. Every number here is deterministic arithmetic over the
 * GL — an add-back is an account's real book activity × a cited disallowance percentage,
 * or an explicit human-pinned timing amount. Absent any tag, taxable income = book NI and
 * the adjustments list is empty (degrade-safe).
 *
 * Sign convention:
 *   - taxable_effect 'ADD'      → the difference INCREASES taxable income above book
 *                                 (a nondeductible book expense, or book-only income).
 *   - taxable_effect 'SUBTRACT' → the difference DECREASES taxable income below book
 *                                 (a tax-only deduction, or book-only tax-exempt income).
 *   All difference amounts are carried as POSITIVE magnitudes; the effect decides the side.
 */

export type DifferenceType = 'PERMANENT' | 'TEMPORARY';
export type TaxableEffect = 'ADD' | 'SUBTRACT';

/** A standard (or tenant-custom) M-1/M-3 adjustment-line definition. */
export interface MLineDef {
  /** stable machine code, e.g. 'MEALS_50'. */
  code: string;
  /** human label rendered on the M-1 line. */
  label: string;
  /** Schedule M-1 (form 1120) line reference, e.g. '5c', '8a'. */
  m1Line: string;
  differenceType: DifferenceType;
  taxableEffect: TaxableEffect;
  /**
   * Fraction (0..100) of an account's book activity that is the difference — 50 for
   * meals, 100 for penalties/federal tax. `null` for a pure timing item (depreciation
   * delta, accrual) whose amount cannot be implied by a single account balance and must
   * be supplied explicitly.
   */
  defaultDisallowancePct: number | null;
  /** cited IRC section, e.g. '§274(n)'. */
  codeSection: string;
  description: string;
}

/**
 * The canonical, code-defined catalog. The engine depends on THIS, not on the database,
 * so an unseeded tenant still computes a correct M-1. Migration 077's
 * `seed_book_tax_m_lines()` mirrors this list into `book_tax_m_lines` for the tagging UI.
 * Keep the two in sync (codes are the contract).
 */
export const STANDARD_M_LINES: readonly MLineDef[] = [
  { code: 'MEALS_50',            label: 'Meals — 50% nondeductible',               m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 50,   codeSection: '§274(n)',    description: 'Business meals are only 50% deductible; add back the disallowed half.' },
  { code: 'ENTERTAINMENT',       label: 'Entertainment — 100% nondeductible',      m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§274(a)',    description: 'Entertainment is fully nondeductible post-TCJA.' },
  { code: 'PENALTIES_FINES',     label: 'Penalties & fines',                       m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§162(f)',    description: 'Government penalties and fines are never deductible.' },
  { code: 'FED_INCOME_TAX',      label: 'Federal income tax per books',            m1Line: '2',  differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§275',       description: 'Federal income tax expensed on the books is not deductible.' },
  { code: 'POLITICAL_LOBBYING',  label: 'Political & lobbying',                    m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§162(e)',    description: 'Political contributions and most lobbying are nondeductible.' },
  { code: 'CLUB_DUES',           label: 'Club dues',                               m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§274(a)(3)', description: 'Social, athletic and business club dues are nondeductible.' },
  { code: 'OFFICER_LIFE_INS',    label: 'Officer life-insurance premiums',         m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§264',       description: 'Premiums where the company is beneficiary are nondeductible.' },
  { code: 'FINES_50_MEALS_ENT',  label: 'Meals & entertainment (blended)',         m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§274',       description: 'Fully-disallowed meals/entertainment where no 50% class applies.' },
  { code: 'TAX_EXEMPT_INTEREST', label: 'Tax-exempt interest income',              m1Line: '7',  differenceType: 'PERMANENT', taxableEffect: 'SUBTRACT', defaultDisallowancePct: 100,  codeSection: '§103',       description: 'Municipal-bond interest is book income excluded from taxable income.' },
  { code: 'MEALS_ENT_NONDED',    label: 'Nondeductible fringe / gifts over limit', m1Line: '5c', differenceType: 'PERMANENT', taxableEffect: 'ADD',      defaultDisallowancePct: 100,  codeSection: '§274',       description: 'Gifts over $25 and other nondeductible fringes.' },
  { code: 'BOOK_DEPR_EXCESS',    label: 'Book depreciation over tax',              m1Line: '5a', differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§167/§168',  description: 'Book depreciation exceeds tax — add the excess (reverses later).' },
  { code: 'TAX_DEPR_EXCESS',     label: 'Tax depreciation over book (§179/bonus)', m1Line: '8a', differenceType: 'TEMPORARY', taxableEffect: 'SUBTRACT', defaultDisallowancePct: null, codeSection: '§168/§179',  description: 'Tax depreciation (MACRS/§179/bonus) exceeds book — subtract the excess.' },
  { code: 'BAD_DEBT_RESERVE',    label: 'Bad-debt reserve vs write-off',           m1Line: '5',  differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§166',       description: 'Book reserve method vs tax specific-charge-off — timing difference.' },
  { code: 'ACCRUED_EXPENSE',     label: 'Accrued expense not yet deductible',      m1Line: '5',  differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§461',       description: 'Accrued but unpaid expenses failing economic performance.' },
  { code: 'ACCRUED_BONUS',       label: 'Accrued bonuses / vacation',              m1Line: '5',  differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§461',       description: 'Accrued comp not paid within 2½ months — deferred to when paid.' },
  { code: 'PREPAID_EXPENSE',     label: 'Prepaid deducted on return',              m1Line: '8',  differenceType: 'TEMPORARY', taxableEffect: 'SUBTRACT', defaultDisallowancePct: null, codeSection: '§263',       description: 'Prepaid amounts deductible for tax ahead of book amortization.' },
  { code: 'WARRANTY_RESERVE',    label: 'Warranty / other reserves',               m1Line: '5',  differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§461',       description: 'Estimated reserves are book-only until the obligation is fixed.' },
  { code: 'SEC_174_RD',          label: '§174 R&D capitalization',                 m1Line: '5',  differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§174',       description: 'R&D now mandatorily capitalized/amortized for tax.' },
  { code: 'DEFERRED_REVENUE',    label: 'Deferred revenue timing',                 m1Line: '4',  differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§451',       description: 'Revenue taxable when received but deferred for book.' },
  { code: 'CHARITABLE_CARRY',    label: 'Charitable contributions over 10% limit', m1Line: '5',  differenceType: 'TEMPORARY', taxableEffect: 'ADD',      defaultDisallowancePct: null, codeSection: '§170',       description: 'Contributions exceeding the 10% limit carry forward.' },
] as const;

const M_LINE_BY_CODE: ReadonlyMap<string, MLineDef> = new Map(
  STANDARD_M_LINES.map((l) => [l.code, l]),
);

/** Look up a standard M-line definition by code (undefined for an unknown/custom code). */
export function findMLine(code: string): MLineDef | undefined {
  return M_LINE_BY_CODE.get(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// Difference-amount resolution (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The disallowance percentage in effect for a tag: an explicit per-tag override wins,
 * else the standard M-line default, else `null` (a timing item needing an explicit amount).
 */
export function effectiveDisallowancePct(
  code: string,
  perTagPct: number | null | undefined,
): number | null {
  if (perTagPct != null) return perTagPct;
  return findMLine(code)?.defaultDisallowancePct ?? null;
}

/**
 * Resolve the book-tax difference amount (positive cents) for an ACCOUNT-level tag from
 * that account's positive book activity in the period.
 *   - A percentage tag (meals 50, penalties 100) → round(activity × pct / 100).
 *   - A pure timing tag (pct null) → 0 here; its amount must come from an explicit
 *     line override / manual amount (the account balance can't imply a depreciation delta).
 * `activityCents` must already be the account's POSITIVE natural activity (expense magnitude
 * for a debit-normal account, income magnitude for a credit-normal account).
 */
export function resolveAccountDifferenceCents(
  activityCents: number,
  code: string,
  perTagPct: number | null | undefined,
): number {
  const pct = effectiveDisallowancePct(code, perTagPct);
  if (pct == null) return 0;
  if (!Number.isFinite(activityCents) || activityCents <= 0) return 0;
  return Math.round((activityCents * pct) / 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// The M-1 reconciliation (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** One resolved book-tax difference fed into the reconciliation. */
export interface TaggedDifference {
  code: string;
  label: string;
  differenceType: DifferenceType;
  taxableEffect: TaxableEffect;
  /** positive magnitude in cents; the effect decides which side it lands on. */
  amountCents: number;
  m1Line?: string;
  codeSection?: string;
  /** where this difference came from (for provenance in the report). */
  source?: 'account' | 'override' | 'manual';
}

/** An aggregated M-1 line in the finished reconciliation. */
export interface M1Line {
  code: string;
  label: string;
  m1Line: string;
  differenceType: DifferenceType;
  taxableEffect: TaxableEffect;
  codeSection: string;
  amountCents: number;
}

/** The full Schedule M-1 reconciliation + M-3 permanent/temporary summary. */
export interface M1Reconciliation {
  bookNetIncomeCents: number;
  /** ADD lines (increase taxable income), aggregated by code, sorted desc by amount. */
  additions: M1Line[];
  /** SUBTRACT lines (decrease taxable income), aggregated by code, sorted desc by amount. */
  subtractions: M1Line[];
  totalAdditionsCents: number;
  totalSubtractionsCents: number;
  taxableIncomeCents: number;
  /** M-3 / ASC 740 split — the net taxable-income impact of each character. */
  permanentNetCents: number;
  temporaryNetCents: number;
  permanentAdditionsCents: number;
  permanentSubtractionsCents: number;
  temporaryAdditionsCents: number;
  temporarySubtractionsCents: number;
  /** count of distinct adjustment lines (0 = degrade-safe: taxable = book NI). */
  adjustmentCount: number;
}

/**
 * Compute the Schedule M-1 reconciliation deterministically.
 *
 * `taxable income = book NI + Σ additions − Σ subtractions`, with every difference split
 * permanent vs temporary. Differences are aggregated by `code` (so meals from three
 * accounts collapse to one M-1 line, as a real return reads), zero-amount differences are
 * dropped, and lines are sorted largest-first within each side. With an empty
 * `differences` array the result is a pass-through: taxable income = book NI.
 */
export function computeM1(
  bookNetIncomeCents: number,
  differences: readonly TaggedDifference[],
): M1Reconciliation {
  // Aggregate by code (a stable, human-meaningful grouping key).
  const byCode = new Map<string, M1Line>();
  for (const d of differences) {
    const amount = Math.round(d.amountCents);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const def = findMLine(d.code);
    const key = d.code;
    const existing = byCode.get(key);
    if (existing) {
      existing.amountCents += amount;
    } else {
      byCode.set(key, {
        code: d.code,
        label: d.label || def?.label || d.code,
        m1Line: d.m1Line ?? def?.m1Line ?? '',
        differenceType: d.differenceType,
        taxableEffect: d.taxableEffect,
        codeSection: d.codeSection ?? def?.codeSection ?? '',
        amountCents: amount,
      });
    }
  }

  const lines = Array.from(byCode.values()).filter((l) => l.amountCents !== 0);

  const additions = lines
    .filter((l) => l.taxableEffect === 'ADD')
    .sort((a, b) => b.amountCents - a.amountCents);
  const subtractions = lines
    .filter((l) => l.taxableEffect === 'SUBTRACT')
    .sort((a, b) => b.amountCents - a.amountCents);

  const totalAdditionsCents = additions.reduce((s, l) => s + l.amountCents, 0);
  const totalSubtractionsCents = subtractions.reduce((s, l) => s + l.amountCents, 0);

  const permanentAdditionsCents = additions
    .filter((l) => l.differenceType === 'PERMANENT')
    .reduce((s, l) => s + l.amountCents, 0);
  const temporaryAdditionsCents = additions
    .filter((l) => l.differenceType === 'TEMPORARY')
    .reduce((s, l) => s + l.amountCents, 0);
  const permanentSubtractionsCents = subtractions
    .filter((l) => l.differenceType === 'PERMANENT')
    .reduce((s, l) => s + l.amountCents, 0);
  const temporarySubtractionsCents = subtractions
    .filter((l) => l.differenceType === 'TEMPORARY')
    .reduce((s, l) => s + l.amountCents, 0);

  return {
    bookNetIncomeCents,
    additions,
    subtractions,
    totalAdditionsCents,
    totalSubtractionsCents,
    taxableIncomeCents: bookNetIncomeCents + totalAdditionsCents - totalSubtractionsCents,
    permanentNetCents: permanentAdditionsCents - permanentSubtractionsCents,
    temporaryNetCents: temporaryAdditionsCents - temporarySubtractionsCents,
    permanentAdditionsCents,
    permanentSubtractionsCents,
    temporaryAdditionsCents,
    temporarySubtractionsCents,
    adjustmentCount: lines.length,
  };
}
