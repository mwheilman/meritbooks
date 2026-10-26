/**
 * The platform crosswalk library (spec §7.1 stage 2): source-system account DETAIL TYPES
 * and system accounts → MeritBooks account ROLES. Deterministic, works with AI off.
 * Accounts are referenced by role, never by number — the service resolves each role to
 * the tenant's own account (lib/posting/account-roles.ts resolveRole).
 *
 * Confidence: 0.95 for control / system roles (A/R, A/P, Undeposited Funds, retained
 * earnings, sales tax payable, credit card payable); 0.85 for ordinary detail types.
 */

import type { AccountRoleKey } from '@/lib/posting/account-roles';

export interface CrosswalkHit {
  role: AccountRoleKey;
  confidence: number;
  reason: string;
}

interface CrosswalkRule {
  /** QuickBooks AccountSubType (detail type) / Xero system account / Intacct category, normalized. */
  keys: string[];
  role: AccountRoleKey;
  confidence: number;
  label: string;
}

const RULES: CrosswalkRule[] = [
  { keys: ['accountsreceivable', 'accounts receivable', 'accountsreceivablear', 'debtors'], role: 'AR_CONTROL', confidence: 0.95, label: 'Accounts receivable' },
  { keys: ['accountspayable', 'accounts payable', 'accountspayableap', 'creditors'], role: 'AP_CONTROL', confidence: 0.95, label: 'Accounts payable' },
  { keys: ['undepositedfunds', 'undeposited funds'], role: 'UNDEPOSITED_FUNDS', confidence: 0.95, label: 'Undeposited Funds → payment clearing' },
  { keys: ['retainedearnings', 'retained earnings'], role: 'RETAINED_EARNINGS', confidence: 0.95, label: 'Retained earnings' },
  { keys: ['salestaxpayable', 'globaltaxpayable', 'sales tax payable', 'gst', 'salestax'], role: 'SALES_TAX_PAYABLE', confidence: 0.95, label: 'Sales tax payable' },
  { keys: ['creditcard', 'credit card'], role: 'CREDIT_CARD_PAYABLE', confidence: 0.95, label: 'Credit card payable' },
  { keys: ['inventory', 'inventoryasset'], role: 'INVENTORY_ASSET', confidence: 0.85, label: 'Inventory' },
  { keys: ['prepaidexpenses', 'prepaid expenses'], role: 'PREPAID_ASSET', confidence: 0.85, label: 'Prepaid expenses' },
  { keys: ['ownersequity', 'partnersequity', 'partnercontributions', 'capitalstock', 'commonstock', 'paidincapitalorsurplus', 'ownerscapital'], role: 'OWNERS_CAPITAL', confidence: 0.85, label: 'Owner’s equity' },
  { keys: ['partnerdistributions', 'ownersdraw', 'personalexpense', 'ownerdraw'], role: 'OWNERS_DRAW', confidence: 0.85, label: 'Owner’s draw / distributions' },
  { keys: ['interestpaid', 'interest expense'], role: 'INTEREST_EXPENSE', confidence: 0.85, label: 'Interest expense' },
  { keys: ['payrollexpenses', 'salarieswages', 'payrollwageandtaxexpenses'], role: 'WAGES_EXPENSE', confidence: 0.85, label: 'Wages' },
  { keys: ['payrolltaxpayable'], role: 'FEDERAL_TAX_PAYABLE', confidence: 0.85, label: 'Payroll taxes payable' },
  { keys: ['notespayable', 'shareholdernotespayable', 'loanpayable'], role: 'NOTES_PAYABLE', confidence: 0.85, label: 'Notes payable' },
  { keys: ['baddebts', 'bad debts'], role: 'BAD_DEBT_EXPENSE', confidence: 0.85, label: 'Bad debt' },
  { keys: ['allowanceforbaddebts'], role: 'ALLOWANCE_DOUBTFUL', confidence: 0.85, label: 'Allowance for doubtful accounts' },
  { keys: ['insurance'], role: 'INSURANCE_EXPENSE', confidence: 0.85, label: 'Insurance' },
];

function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

const BY_KEY = new Map<string, CrosswalkRule>();
for (const r of RULES) for (const k of r.keys) BY_KEY.set(normalize(k).replace(/ /g, ''), r);

/** The roles the crosswalk can ever propose (the service pre-resolves only these). */
export const CROSSWALK_ROLES: readonly AccountRoleKey[] = Array.from(new Set(RULES.map((r) => r.role)));

/**
 * Crosswalk hit for one source account, by detail type first, then by the source
 * system's account type (QBO "Accounts Receivable", "Credit Card"). Null = no hit.
 */
export function crosswalkFor(input: { detailType: string | null; sourceType: string | null }): CrosswalkHit | null {
  for (const raw of [input.detailType, input.sourceType]) {
    const k = normalize(raw).replace(/ /g, '');
    if (!k) continue;
    const r = BY_KEY.get(k);
    if (r) {
      return {
        role: r.role,
        confidence: r.confidence,
        reason: `${raw === input.detailType ? 'Detail type' : 'Account type'} “${raw}” → ${r.label} (crosswalk)`,
      };
    }
  }
  return null;
}

/** "Opening Balance Equity" is a data-quality item, not a crosswalk: it goes to retained earnings with the controller's approval. */
export function isOpeningBalanceEquity(input: { detailType: string | null; name: string }): boolean {
  return normalize(input.detailType).replace(/ /g, '') === 'openingbalanceequity' || /opening\s+balance\s+equity/i.test(input.name);
}
