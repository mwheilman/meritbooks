/**
 * GL account classes — how a metric input like "Revenue" or "Total debt" maps onto a
 * tenant's chart of accounts. Resolution is BY ROLE / TYPE / SUB-TYPE (canon §2: the
 * COA is per tenant; never hard-code account numbers). Name patterns are a last
 * resort for families the COA has no role for (D&A, interest, debt), mirroring
 * lib/covenants/ledger.ts so covenants and KPIs agree.
 *
 * `classifyAccounts` is pure and is what every data-source adapter uses.
 */

import { ROLE_DEFAULT_NUMBER } from '@/lib/posting/account-roles';
import type { AccountClass, ClassMapping } from './types';

/** How a class turns GL lines into a monthly flow. */
export type ClassMeasure =
  /** credit − debit (revenue, liabilities, other income). */
  | 'net_credit'
  /** debit − credit (expenses, assets). */
  | 'net_debit'
  /** gross debits only (capex additions, debt repaid, distributions). */
  | 'debit_activity'
  /** gross credits only (debt drawn, contributions). */
  | 'credit_activity';

export interface AccountMeta {
  id: string;
  number: string;
  name: string;
  type: string; // ASSET | LIABILITY | EQUITY | REVENUE | COGS | OPEX | OTHER
  subType: string; // CURRENT_ASSET … OTHER_EXPENSE
  isBank: boolean;
  isCreditCard: boolean;
}

interface Matcher {
  role?: string[];
  type?: string[];
  subType?: string[];
  name?: RegExp;
  notName?: RegExp;
  bank?: boolean;
}

export interface AccountClassDef {
  key: AccountClass;
  label: string;
  measure: ClassMeasure;
  statement: 'income_statement' | 'balance_sheet';
  /** When no account matches: a legitimate zero (no such activity) or "not mapped". */
  emptyMeans: 'zero' | 'not_mapped';
  /** Account roles that feed this class (named in the not-mapped message). */
  roles: string[];
  matchers: Matcher[];
}

const DA_RE = /deprec|amortiz/i;
const ACCUM_RE = /accum/i;
const INTEREST_RE = /interest/i;
const DEBT_RE = /loan|note[s]? payable|debt|line of credit|revolver|mortgage|bond|term loan/i;
const INTANGIBLE_RE = /goodwill|intangible|trademark|patent/i;
const PAYROLL_RE = /wage|salar|payroll|bonus|commission/i;
const VARIABLE_RE = /commission|merchant|freight|shipping|fuel|subcontract/i;
const TAX_RE = /income tax/i;
const DRAW_RE = /draw|distribution|dividend/i;
const CONTRIB_RE = /contribut|capital/i;

export const ACCOUNT_CLASSES: Record<AccountClass, AccountClassDef> = {
  revenue: { key: 'revenue', label: 'Revenue', measure: 'net_credit', statement: 'income_statement', emptyMeans: 'not_mapped', roles: [], matchers: [{ type: ['REVENUE'] }] },
  cogs: { key: 'cogs', label: 'Cost of revenue', measure: 'net_debit', statement: 'income_statement', emptyMeans: 'zero', roles: [], matchers: [{ type: ['COGS'] }] },
  opex: { key: 'opex', label: 'Operating expenses', measure: 'net_debit', statement: 'income_statement', emptyMeans: 'zero', roles: [], matchers: [{ type: ['OPEX'] }] },
  other_income: { key: 'other_income', label: 'Other income', measure: 'net_credit', statement: 'income_statement', emptyMeans: 'zero', roles: [], matchers: [{ type: ['OTHER'], subType: ['OTHER_INCOME'] }] },
  other_expense: { key: 'other_expense', label: 'Other expense', measure: 'net_debit', statement: 'income_statement', emptyMeans: 'zero', roles: [], matchers: [{ type: ['OTHER'], subType: ['OTHER_EXPENSE'] }] },
  da_operating: {
    key: 'da_operating',
    label: 'Depreciation & amortization (in operating costs)',
    measure: 'net_debit',
    statement: 'income_statement',
    emptyMeans: 'zero',
    roles: [],
    matchers: [{ type: ['COGS', 'OPEX'], name: DA_RE }],
  },
  da_opex: {
    key: 'da_opex',
    label: 'Depreciation & amortization (in operating expenses)',
    measure: 'net_debit',
    statement: 'income_statement',
    emptyMeans: 'zero',
    roles: [],
    matchers: [{ type: ['OPEX'], name: DA_RE }],
  },
  da_total: {
    key: 'da_total',
    label: 'Depreciation & amortization',
    measure: 'net_debit',
    statement: 'income_statement',
    emptyMeans: 'zero',
    roles: [],
    matchers: [{ type: ['COGS', 'OPEX', 'OTHER'], name: DA_RE, notName: /gain|loss/i }],
  },
  interest_expense: {
    key: 'interest_expense',
    label: 'Interest expense',
    measure: 'net_debit',
    statement: 'income_statement',
    emptyMeans: 'zero',
    roles: ['INTEREST_EXPENSE', 'FLOOR_PLAN_INTEREST'],
    matchers: [{ role: ['INTEREST_EXPENSE', 'FLOOR_PLAN_INTEREST'] }, { type: ['OPEX', 'OTHER'], name: INTEREST_RE, notName: /income/i }],
  },
  income_tax_expense: {
    key: 'income_tax_expense',
    label: 'Income tax expense',
    measure: 'net_debit',
    statement: 'income_statement',
    emptyMeans: 'zero',
    roles: ['INCOME_TAX_EXPENSE'],
    matchers: [{ role: ['INCOME_TAX_EXPENSE'] }, { type: ['OPEX', 'OTHER'], name: TAX_RE }],
  },
  payroll_expense: {
    key: 'payroll_expense',
    label: 'Payroll & benefits',
    measure: 'net_debit',
    statement: 'income_statement',
    emptyMeans: 'not_mapped',
    roles: ['WAGES_EXPENSE', 'PAYROLL_TAX_EXPENSE', 'HEALTH_INSURANCE_EXPENSE', 'RETIREMENT_MATCH_EXPENSE', 'WORKERS_COMP_EXPENSE'],
    matchers: [
      { role: ['WAGES_EXPENSE', 'PAYROLL_TAX_EXPENSE', 'HEALTH_INSURANCE_EXPENSE', 'RETIREMENT_MATCH_EXPENSE', 'WORKERS_COMP_EXPENSE'] },
      { type: ['COGS', 'OPEX'], name: PAYROLL_RE },
    ],
  },
  variable_opex: {
    key: 'variable_opex',
    label: 'Variable operating costs',
    measure: 'net_debit',
    statement: 'income_statement',
    emptyMeans: 'zero',
    roles: ['MERCHANT_FEE_EXPENSE'],
    matchers: [{ role: ['MERCHANT_FEE_EXPENSE'] }, { type: ['OPEX'], name: VARIABLE_RE }],
  },
  capex: {
    key: 'capex',
    label: 'Capital expenditure (fixed-asset additions)',
    measure: 'debit_activity',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: [],
    matchers: [{ subType: ['FIXED_ASSET'], notName: ACCUM_RE }],
  },
  debt_repaid: {
    key: 'debt_repaid',
    label: 'Debt principal repaid',
    measure: 'debit_activity',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['NOTES_PAYABLE'],
    matchers: [{ role: ['NOTES_PAYABLE'] }, { type: ['LIABILITY'], name: DEBT_RE, notName: INTEREST_RE }],
  },
  debt_drawn: {
    key: 'debt_drawn',
    label: 'Debt drawn',
    measure: 'credit_activity',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['NOTES_PAYABLE'],
    matchers: [{ role: ['NOTES_PAYABLE'] }, { type: ['LIABILITY'], name: DEBT_RE, notName: INTEREST_RE }],
  },
  distributions: {
    key: 'distributions',
    label: 'Owner draws & distributions',
    measure: 'debit_activity',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['OWNERS_DRAW'],
    matchers: [{ role: ['OWNERS_DRAW'] }, { type: ['EQUITY'], name: DRAW_RE }],
  },
  contributions: {
    key: 'contributions',
    label: 'Owner contributions',
    measure: 'credit_activity',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['OWNERS_CAPITAL'],
    matchers: [{ role: ['OWNERS_CAPITAL'] }, { type: ['EQUITY'], name: CONTRIB_RE, notName: /retained|earnings|draw|distribution/i }],
  },
  cash: {
    key: 'cash',
    label: 'Cash',
    measure: 'net_debit',
    statement: 'balance_sheet',
    emptyMeans: 'not_mapped',
    roles: ['OPERATING_BANK', 'CASH_ON_HAND', 'UNDEPOSITED_FUNDS'],
    matchers: [{ bank: true, type: ['ASSET'] }, { role: ['OPERATING_BANK', 'CASH_ON_HAND', 'UNDEPOSITED_FUNDS'] }],
  },
  ar: {
    key: 'ar',
    label: 'Accounts receivable',
    measure: 'net_debit',
    statement: 'balance_sheet',
    emptyMeans: 'not_mapped',
    roles: ['AR_CONTROL'],
    matchers: [{ role: ['AR_CONTROL'] }],
  },
  inventory: {
    key: 'inventory',
    label: 'Inventory',
    measure: 'net_debit',
    statement: 'balance_sheet',
    emptyMeans: 'not_mapped',
    roles: ['INVENTORY_ASSET', 'WHOLE_GOODS_INVENTORY', 'USED_WHOLE_GOODS_INVENTORY'],
    matchers: [
      { role: ['INVENTORY_ASSET', 'WHOLE_GOODS_INVENTORY', 'USED_WHOLE_GOODS_INVENTORY'] },
      { subType: ['CURRENT_ASSET'], name: /inventor/i },
    ],
  },
  current_assets: { key: 'current_assets', label: 'Current assets', measure: 'net_debit', statement: 'balance_sheet', emptyMeans: 'not_mapped', roles: [], matchers: [{ subType: ['CURRENT_ASSET'] }] },
  current_liabilities: {
    key: 'current_liabilities',
    label: 'Current liabilities',
    measure: 'net_credit',
    statement: 'balance_sheet',
    emptyMeans: 'not_mapped',
    roles: [],
    matchers: [{ subType: ['CURRENT_LIABILITY'] }],
  },
  total_assets: { key: 'total_assets', label: 'Total assets', measure: 'net_debit', statement: 'balance_sheet', emptyMeans: 'not_mapped', roles: [], matchers: [{ type: ['ASSET'] }] },
  total_liabilities: { key: 'total_liabilities', label: 'Total liabilities', measure: 'net_credit', statement: 'balance_sheet', emptyMeans: 'zero', roles: [], matchers: [{ type: ['LIABILITY'] }] },
  ap: { key: 'ap', label: 'Accounts payable', measure: 'net_credit', statement: 'balance_sheet', emptyMeans: 'not_mapped', roles: ['AP_CONTROL'], matchers: [{ role: ['AP_CONTROL'] }] },
  total_debt: {
    key: 'total_debt',
    label: 'Total debt',
    measure: 'net_credit',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['NOTES_PAYABLE', 'FLOOR_PLAN_PAYABLE'],
    matchers: [{ role: ['NOTES_PAYABLE', 'FLOOR_PLAN_PAYABLE'] }, { type: ['LIABILITY'], name: DEBT_RE, notName: INTEREST_RE }],
  },
  intangibles: {
    key: 'intangibles',
    label: 'Goodwill & intangibles',
    measure: 'net_debit',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['INTANGIBLE_ASSET', 'ACCUMULATED_AMORTIZATION'],
    matchers: [{ role: ['INTANGIBLE_ASSET', 'ACCUMULATED_AMORTIZATION'] }, { type: ['ASSET'], name: INTANGIBLE_RE }],
  },
  retainage_receivable: {
    key: 'retainage_receivable',
    label: 'Retainage receivable',
    measure: 'net_debit',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['RETAINAGE_RECEIVABLE'],
    matchers: [{ role: ['RETAINAGE_RECEIVABLE'] }],
  },
  retainage_payable: {
    key: 'retainage_payable',
    label: 'Retainage payable',
    measure: 'net_credit',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['RETAINAGE_PAYABLE'],
    matchers: [{ role: ['RETAINAGE_PAYABLE'] }],
  },
  underbillings: {
    key: 'underbillings',
    label: 'Costs and earnings in excess of billings (contract asset)',
    measure: 'net_debit',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['UNBILLED_RECEIVABLE'],
    matchers: [{ role: ['UNBILLED_RECEIVABLE'] }],
  },
  overbillings: {
    key: 'overbillings',
    label: 'Billings in excess of costs and earnings (contract liability)',
    measure: 'net_credit',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['DEFERRED_REVENUE'],
    matchers: [{ role: ['DEFERRED_REVENUE'] }],
  },
  customer_deposits: {
    key: 'customer_deposits',
    label: 'Customer deposits',
    measure: 'net_credit',
    statement: 'balance_sheet',
    emptyMeans: 'zero',
    roles: ['CUSTOMER_DEPOSITS'],
    matchers: [{ role: ['CUSTOMER_DEPOSITS'] }],
  },
  floor_plan_payable: {
    key: 'floor_plan_payable',
    label: 'Floor plan payable',
    measure: 'net_credit',
    statement: 'balance_sheet',
    emptyMeans: 'not_mapped',
    roles: ['FLOOR_PLAN_PAYABLE'],
    matchers: [{ role: ['FLOOR_PLAN_PAYABLE'] }, { type: ['LIABILITY'], name: /floor ?plan/i }],
  },
};

export const ACCOUNT_CLASS_KEYS = Object.keys(ACCOUNT_CLASSES) as AccountClass[];

/** Is this class a balance (net) class that a `balance` input may read? */
export function isNetClass(cls: AccountClass): boolean {
  const m = ACCOUNT_CLASSES[cls].measure;
  return m === 'net_debit' || m === 'net_credit';
}

/**
 * Resolve every class to account ids.
 * @param roleAccounts role_key → account ids from public.account_roles (any location).
 * @param roleDefaults role_key → standard COA number, used only when a role has no
 *   account_roles row (same fallback order as lib/posting/account-roles.ts).
 */
export function classifyAccounts(
  accounts: AccountMeta[],
  roleAccounts: Map<string, string[]>,
  roleDefaults: Record<string, string> = ROLE_DEFAULT_NUMBER,
): Partial<Record<AccountClass, ClassMapping>> {
  const byNumber = new Map(accounts.map((a) => [a.number, a.id]));
  const roleIds = (role: string): { ids: string[]; via: ClassMapping['via'][number] } | null => {
    const mapped = roleAccounts.get(role);
    if (mapped && mapped.length > 0) return { ids: mapped, via: 'role' };
    const num = roleDefaults[role];
    const id = num ? byNumber.get(num) : undefined;
    return id ? { ids: [id], via: 'role_default_number' } : null;
  };

  const out: Partial<Record<AccountClass, ClassMapping>> = {};
  for (const def of Object.values(ACCOUNT_CLASSES)) {
    const ids = new Set<string>();
    const via = new Set<ClassMapping['via'][number]>();
    for (const m of def.matchers) {
      if (m.role) {
        for (const role of m.role) {
          const r = roleIds(role);
          if (r) {
            r.ids.forEach((id) => ids.add(id));
            via.add(r.via);
          }
        }
        continue;
      }
      for (const a of accounts) {
        if (m.type && !m.type.includes(a.type)) continue;
        if (m.subType && !m.subType.includes(a.subType)) continue;
        if (m.bank !== undefined && a.isBank !== m.bank) continue;
        if (m.name && !m.name.test(a.name)) continue;
        if (m.notName && m.notName.test(a.name)) continue;
        ids.add(a.id);
        via.add(m.name ? 'name' : 'type');
      }
    }
    if (ids.size > 0) out[def.key] = { accountIds: [...ids].sort(), via: [...via].sort() };
  }
  return out;
}
