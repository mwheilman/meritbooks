/**
 * DIRECT-METHOD statement of cash flows — pure classification engine.
 *
 * No I/O. Where the INDIRECT method (`/api/reports/cash-flow`) starts from net
 * income and adjusts for non-cash items and working-capital swings, the DIRECT
 * method reports the actual cash receipts and disbursements themselves:
 *
 *   • cash received from customers
 *   • cash paid to suppliers
 *   • cash paid to / on behalf of employees
 *   • interest paid, income tax paid, other operating
 *   • investing (capex / asset sales) and financing (debt / equity / distributions)
 *
 * How it works: every posted journal entry that MOVES CASH is decomposed into
 * its cash legs and its counterpart (non-cash) legs. In a balanced double entry,
 * Σ(cash debit − credit) = −Σ(counterpart debit − credit), so each counterpart
 * leg's contribution to the cash movement is `credit − credit`… precisely
 * `creditCents − debitCents`. We classify each counterpart leg into a direct
 * line by its account TYPE / SUB-TYPE / ROLE (never a hard-coded number —
 * CANON-ANCHOR §2) and sum the contributions.
 *
 * Tie-out: the sum of all classified line amounts MUST equal the independently
 * measured net change in the cash accounts. The engine returns that variance so
 * the caller (and a test) can assert reconciliation.
 *
 * Money is bigint cents throughout — never floating point.
 */

export type DirectSection = 'OPERATING' | 'INVESTING' | 'FINANCING';

export type DirectLineKey =
  | 'CUSTOMER_RECEIPTS'
  | 'SUPPLIER_PAYMENTS'
  | 'EMPLOYEE_PAYMENTS'
  | 'INTEREST_PAID'
  | 'INCOME_TAX_PAID'
  | 'OTHER_OPERATING'
  | 'CAPEX'
  | 'ASSET_SALES'
  | 'OTHER_INVESTING'
  | 'DEBT_FINANCING'
  | 'EQUITY_CONTRIBUTIONS'
  | 'DISTRIBUTIONS'
  | 'OTHER_FINANCING';

/** Role hints the caller resolves once (by role, not number) and tags each leg with. */
export type DirectRoleTag =
  | 'AR_CONTROL'
  | 'UNBILLED_RECEIVABLE'
  | 'RETAINAGE_RECEIVABLE'
  | 'CUSTOMER_DEPOSITS'
  | 'DEFERRED_REVENUE'
  | 'ALLOWANCE_DOUBTFUL'
  | 'AP_CONTROL'
  | 'ACCRUED_EXPENSES'
  | 'CREDIT_CARD_PAYABLE'
  | 'RETAINAGE_PAYABLE'
  | 'WAGES_EXPENSE'
  | 'PAYROLL_TAX_EXPENSE'
  | 'FEDERAL_TAX_PAYABLE'
  | 'STATE_TAX_PAYABLE'
  | 'FICA_PAYABLE'
  | 'HEALTH_INSURANCE_PAYABLE'
  | 'RETIREMENT_PAYABLE'
  | 'WORKERS_COMP_PAYABLE'
  | 'GARNISHMENT_PAYABLE'
  | 'HEALTH_INSURANCE_EXPENSE'
  | 'RETIREMENT_MATCH_EXPENSE'
  | 'WORKERS_COMP_EXPENSE'
  | 'OWNERS_DRAW'
  | 'OWNERS_CAPITAL';

/** One counterpart (non-cash) leg of a cash-moving journal entry. */
export interface CounterpartLeg {
  accountType: string; // ASSET | LIABILITY | EQUITY | REVENUE | COGS | OPEX | OTHER
  accountSubType: string; // e.g. FIXED_ASSET, LONG_TERM_LIABILITY, OTHER_INCOME
  accountName: string;
  debitCents: number;
  creditCents: number;
  roleTags?: DirectRoleTag[];
}

export interface DirectCashInput {
  beginningCashCents: number;
  /**
   * Independently measured net change in the CASH accounts over the period
   * (Σ debit − credit across cash/equivalent accounts). Used only for the
   * reconciliation check — the reported net change is the sum of classified lines.
   */
  netCashChangeCents: number;
  legs: CounterpartLeg[];
}

export interface DirectLine {
  key: DirectLineKey;
  label: string;
  section: DirectSection;
  amountCents: number; // signed: inflow positive, outflow negative
}

export interface DirectSectionResult {
  lines: DirectLine[];
  totalCents: number;
}

export interface DirectCashFlowResult {
  operating: DirectSectionResult;
  investing: DirectSectionResult;
  financing: DirectSectionResult;
  /** Sum of every classified line — the reported net change in cash. */
  netChangeCents: number;
  beginningCashCents: number;
  endingCashCents: number;
  /** netCashChangeCents − netChangeCents. Zero ⇒ the statement ties out. */
  varianceCents: number;
  reconciled: boolean;
}

const SECTION_OF: Record<DirectLineKey, DirectSection> = {
  CUSTOMER_RECEIPTS: 'OPERATING',
  SUPPLIER_PAYMENTS: 'OPERATING',
  EMPLOYEE_PAYMENTS: 'OPERATING',
  INTEREST_PAID: 'OPERATING',
  INCOME_TAX_PAID: 'OPERATING',
  OTHER_OPERATING: 'OPERATING',
  CAPEX: 'INVESTING',
  ASSET_SALES: 'INVESTING',
  OTHER_INVESTING: 'INVESTING',
  DEBT_FINANCING: 'FINANCING',
  EQUITY_CONTRIBUTIONS: 'FINANCING',
  DISTRIBUTIONS: 'FINANCING',
  OTHER_FINANCING: 'FINANCING',
};

const LABEL_OF: Record<DirectLineKey, string> = {
  CUSTOMER_RECEIPTS: 'Cash received from customers',
  SUPPLIER_PAYMENTS: 'Cash paid to suppliers',
  EMPLOYEE_PAYMENTS: 'Cash paid to / for employees',
  INTEREST_PAID: 'Interest paid',
  INCOME_TAX_PAID: 'Income taxes paid',
  OTHER_OPERATING: 'Other operating cash flows',
  CAPEX: 'Purchases of property & equipment',
  ASSET_SALES: 'Proceeds from asset sales',
  OTHER_INVESTING: 'Other investing cash flows',
  DEBT_FINANCING: 'Debt proceeds / (repayments)',
  EQUITY_CONTRIBUTIONS: 'Owner / equity contributions',
  DISTRIBUTIONS: 'Distributions & owner draws',
  OTHER_FINANCING: 'Other financing cash flows',
};

/** Display order within each section. */
const LINE_ORDER: DirectLineKey[] = [
  'CUSTOMER_RECEIPTS',
  'SUPPLIER_PAYMENTS',
  'EMPLOYEE_PAYMENTS',
  'INTEREST_PAID',
  'INCOME_TAX_PAID',
  'OTHER_OPERATING',
  'CAPEX',
  'ASSET_SALES',
  'OTHER_INVESTING',
  'DEBT_FINANCING',
  'EQUITY_CONTRIBUTIONS',
  'DISTRIBUTIONS',
  'OTHER_FINANCING',
];

function hasAny(tags: Set<DirectRoleTag>, ...keys: DirectRoleTag[]): boolean {
  return keys.some((k) => tags.has(k));
}

/**
 * Classify a counterpart leg into a direct-method line. `cashContribution` is
 * `creditCents − debitCents` (positive ⇒ this leg explains a cash INFLOW).
 */
export function classifyLeg(leg: CounterpartLeg, cashContributionCents: number): DirectLineKey {
  const name = (leg.accountName ?? '').toLowerCase();
  const type = leg.accountType;
  const sub = leg.accountSubType;
  const tags = new Set<DirectRoleTag>(leg.roleTags ?? []);

  // ── Customer side: revenue and the receivable / deferred-revenue family ──
  if (type === 'REVENUE') return 'CUSTOMER_RECEIPTS';
  if (
    hasAny(
      tags,
      'AR_CONTROL',
      'UNBILLED_RECEIVABLE',
      'RETAINAGE_RECEIVABLE',
      'CUSTOMER_DEPOSITS',
      'DEFERRED_REVENUE',
      'ALLOWANCE_DOUBTFUL'
    )
  ) {
    return 'CUSTOMER_RECEIPTS';
  }

  // ── Employee side: wages, payroll taxes, benefits and their payables ──
  if (
    hasAny(
      tags,
      'WAGES_EXPENSE',
      'PAYROLL_TAX_EXPENSE',
      'FEDERAL_TAX_PAYABLE',
      'STATE_TAX_PAYABLE',
      'FICA_PAYABLE',
      'HEALTH_INSURANCE_PAYABLE',
      'RETIREMENT_PAYABLE',
      'WORKERS_COMP_PAYABLE',
      'GARNISHMENT_PAYABLE',
      'HEALTH_INSURANCE_EXPENSE',
      'RETIREMENT_MATCH_EXPENSE',
      'WORKERS_COMP_EXPENSE'
    )
  ) {
    return 'EMPLOYEE_PAYMENTS';
  }
  if (/payroll|\bwages?\b|salar|employee benefit/.test(name)) return 'EMPLOYEE_PAYMENTS';

  // ── Named operating outflows ──
  if (/interest/.test(name)) return 'INTEREST_PAID';
  if (/income tax/.test(name)) return 'INCOME_TAX_PAID';

  switch (type) {
    case 'COGS':
    case 'OPEX':
      return 'SUPPLIER_PAYMENTS';
    case 'ASSET':
      if (sub === 'FIXED_ASSET' || sub === 'OTHER_ASSET') {
        // Cash out to acquire an asset ⇒ capex; cash in ⇒ disposal proceeds.
        return cashContributionCents < 0 ? 'CAPEX' : 'ASSET_SALES';
      }
      // Non-cash current asset (inventory, prepaid…) settled in cash ⇒ operating.
      return 'SUPPLIER_PAYMENTS';
    case 'LIABILITY':
      if (sub === 'LONG_TERM_LIABILITY') return 'DEBT_FINANCING';
      if (hasAny(tags, 'AP_CONTROL', 'ACCRUED_EXPENSES', 'CREDIT_CARD_PAYABLE', 'RETAINAGE_PAYABLE')) {
        return 'SUPPLIER_PAYMENTS';
      }
      if (/note payable|loan|line of credit|debt/.test(name)) return 'DEBT_FINANCING';
      return 'OTHER_OPERATING';
    case 'EQUITY':
      if (hasAny(tags, 'OWNERS_DRAW') || /draw|distribution|dividend/.test(name)) return 'DISTRIBUTIONS';
      return 'EQUITY_CONTRIBUTIONS';
    case 'OTHER':
      return 'OTHER_OPERATING';
    default:
      return 'OTHER_OPERATING';
  }
}

/**
 * Build the direct-method statement from the counterpart legs of every
 * cash-moving journal entry in the period.
 */
export function computeDirectCashFlow(input: DirectCashInput): DirectCashFlowResult {
  const totals = new Map<DirectLineKey, number>();

  for (const leg of input.legs) {
    const contribution = Number(leg.creditCents ?? 0) - Number(leg.debitCents ?? 0);
    if (contribution === 0) continue;
    const key = classifyLeg(leg, contribution);
    totals.set(key, (totals.get(key) ?? 0) + contribution);
  }

  const sections: Record<DirectSection, DirectLine[]> = { OPERATING: [], INVESTING: [], FINANCING: [] };
  for (const key of LINE_ORDER) {
    const amount = totals.get(key);
    if (amount === undefined || amount === 0) continue;
    sections[SECTION_OF[key]].push({ key, label: LABEL_OF[key], section: SECTION_OF[key], amountCents: amount });
  }

  const sectionResult = (s: DirectSection): DirectSectionResult => ({
    lines: sections[s],
    totalCents: sections[s].reduce((sum, l) => sum + l.amountCents, 0),
  });

  const operating = sectionResult('OPERATING');
  const investing = sectionResult('INVESTING');
  const financing = sectionResult('FINANCING');
  const netChangeCents = operating.totalCents + investing.totalCents + financing.totalCents;
  const varianceCents = input.netCashChangeCents - netChangeCents;

  return {
    operating,
    investing,
    financing,
    netChangeCents,
    beginningCashCents: input.beginningCashCents,
    endingCashCents: input.beginningCashCents + netChangeCents,
    varianceCents,
    reconciled: varianceCents === 0,
  };
}
