/**
 * Account-role resolution.
 *
 * Posting templates address accounts by ROLE ("the AP control account", "the
 * cash account for this rail", "the deferred-revenue account") — never by a
 * hard-coded account number. This resolver turns a role into the tenant's real
 * account, in priority order:
 *
 *   1. public.account_roles mapping (a per-location row wins over an org-wide row)
 *   2. the role's standard COA account number (core.account_role_keys default)
 *   3. PostingError — the engine refuses to guess; it stops with a clear reason
 *      rather than post to the wrong account.
 *
 * This subsumes the ad-hoc `acctByNumber` lookups currently scattered through
 * rev-rec / bill-ap / billing-consumer; those paths migrate onto this resolver
 * in the lifecycle step.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountType, AccountSubType } from './account-direction';
import type { PaymentRail } from './transaction-types';

type DB = SupabaseClient;

export type AccountRoleKey =
  | 'AP_CONTROL'
  | 'AR_CONTROL'
  | 'OPERATING_BANK'
  | 'CASH_ON_HAND'
  | 'UNDEPOSITED_FUNDS'
  | 'CREDIT_CARD_PAYABLE'
  | 'SALES_TAX_PAYABLE'
  | 'DEFERRED_REVENUE'
  | 'UNBILLED_RECEIVABLE'
  | 'CUSTOMER_DEPOSITS'
  | 'RETAINAGE_RECEIVABLE'
  | 'RETAINAGE_PAYABLE'
  | 'ACCRUED_EXPENSES'
  | 'ALLOWANCE_DOUBTFUL'
  | 'RETAINED_EARNINGS'
  | 'CURRENT_YEAR_EARNINGS'
  | 'OWNERS_CAPITAL'
  | 'OWNERS_DRAW'
  | 'JOB_WIP'
  | 'INTERCOMPANY_AR'
  | 'INTERCOMPANY_AP'
  // Fixed-asset disposal (gain = OTHER income, loss = OTHER expense)
  | 'GAIN_ON_DISPOSAL'
  | 'LOSS_ON_DISPOSAL'
  // Money movement (GATE 12)
  | 'SETTLEMENT_CLEARING'
  | 'PAYMENTS_IN_TRANSIT'
  | 'MERCHANT_FEE_EXPENSE'
  // Platform operator fee income (Merit-as-platform)
  | 'PLATFORM_FEE_INCOME'
  // Payroll posting (GATE 12.3)
  | 'WAGES_EXPENSE'
  | 'PAYROLL_TAX_EXPENSE'
  | 'FEDERAL_TAX_PAYABLE'
  | 'STATE_TAX_PAYABLE'
  | 'FICA_PAYABLE'
  | 'HEALTH_INSURANCE_PAYABLE'
  | 'RETIREMENT_PAYABLE'
  | 'WORKERS_COMP_PAYABLE'
  | 'GARNISHMENT_PAYABLE'
  // Employer benefit expenses (GATE 12.3 refinement)
  | 'HEALTH_INSURANCE_EXPENSE'
  | 'RETIREMENT_MATCH_EXPENSE'
  | 'WORKERS_COMP_EXPENSE';

/** Standard COA numbers per role — fallback when account_roles isn't seeded. */
const ROLE_DEFAULT_NUMBER: Record<AccountRoleKey, string> = {
  AP_CONTROL: '2000',
  AR_CONTROL: '1100',
  OPERATING_BANK: '1000',
  CASH_ON_HAND: '1050',
  UNDEPOSITED_FUNDS: '1090',
  CREDIT_CARD_PAYABLE: '2100',
  SALES_TAX_PAYABLE: '2300',
  DEFERRED_REVENUE: '2410',
  UNBILLED_RECEIVABLE: '1180',
  CUSTOMER_DEPOSITS: '2420',
  RETAINAGE_RECEIVABLE: '1110',
  RETAINAGE_PAYABLE: '2010',
  ACCRUED_EXPENSES: '2400',
  ALLOWANCE_DOUBTFUL: '1150',
  RETAINED_EARNINGS: '3020',
  CURRENT_YEAR_EARNINGS: '3030',
  OWNERS_CAPITAL: '3000',
  OWNERS_DRAW: '3010',
  JOB_WIP: '1210',
  INTERCOMPANY_AR: '1160',
  INTERCOMPANY_AP: '2020',
  // Fixed-asset disposal
  GAIN_ON_DISPOSAL: '7010',
  LOSS_ON_DISPOSAL: '8010',
  // Money movement (GATE 12)
  SETTLEMENT_CLEARING: '1095',
  PAYMENTS_IN_TRANSIT: '1096',
  MERCHANT_FEE_EXPENSE: '6630',
  // Platform operator fee income (Merit-as-platform)
  PLATFORM_FEE_INCOME: '4910',
  // Payroll posting (GATE 12.3)
  WAGES_EXPENSE: '6000',
  PAYROLL_TAX_EXPENSE: '6010',
  FEDERAL_TAX_PAYABLE: '2200',
  STATE_TAX_PAYABLE: '2210',
  FICA_PAYABLE: '2220',
  HEALTH_INSURANCE_PAYABLE: '2230',
  RETIREMENT_PAYABLE: '2240',
  WORKERS_COMP_PAYABLE: '2250',
  GARNISHMENT_PAYABLE: '2270',
  // Employer benefit expenses (GATE 12.3 refinement)
  HEALTH_INSURANCE_EXPENSE: '6020',
  RETIREMENT_MATCH_EXPENSE: '6030',
  WORKERS_COMP_EXPENSE: '6040',
};

/** A resolved account, carrying the type/sub-type the direction helper needs. */
export interface AccountRef {
  id: string;
  account_type: AccountType;
  account_sub_type: AccountSubType;
  account_number: string;
}

/** Thrown when the engine cannot resolve a role/account — never posts a guess. */
export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostingError';
  }
}

interface AccountRow {
  id: string;
  account_type: AccountType;
  account_sub_type: AccountSubType;
  account_number: string;
}

/** Fetch an explicit account (e.g. the category the AI/processor chose). */
export async function getAccountRef(
  db: DB,
  orgId: string,
  accountId: string
): Promise<AccountRef> {
  const { data, error } = await db
    .from('accounts')
    .select('id, account_type, account_sub_type, account_number')
    .eq('org_id', orgId)
    .eq('id', accountId)
    .maybeSingle<AccountRow>();
  if (error) throw new PostingError(`Account lookup failed: ${error.message}`);
  if (!data) throw new PostingError(`Account ${accountId} not found in org`);
  return data;
}

async function accountByNumber(
  db: DB,
  orgId: string,
  number: string,
  locationId?: string
): Promise<AccountRef | null> {
  let query = db
    .from('accounts')
    .select('id, account_type, account_sub_type, account_number, is_company_specific, company_location_id')
    .eq('org_id', orgId)
    .eq('account_number', number)
    .eq('is_active', true);
  // For a company-specific account prefer the one owned by this location.
  if (locationId) query = query.or(`company_location_id.eq.${locationId},company_location_id.is.null`);
  const { data } = await query.limit(1).maybeSingle<AccountRow>();
  return data ?? null;
}

/**
 * Resolve a role to the tenant's account. `locationId` is required for
 * LOCATION-scoped roles (bank / cash / credit card) and ignored otherwise.
 */
export async function resolveRole(
  db: DB,
  orgId: string,
  role: AccountRoleKey,
  locationId?: string
): Promise<AccountRef> {
  // 1. Explicit mapping — a location-specific row wins over an org-wide row.
  const { data: maps } = await db
    .from('account_roles')
    .select('account_id, location_id')
    .eq('org_id', orgId)
    .eq('role_key', role);

  if (maps && maps.length > 0) {
    const rows = maps as { account_id: string; location_id: string | null }[];
    const chosen =
      (locationId && rows.find((r) => r.location_id === locationId)) ||
      rows.find((r) => r.location_id === null) ||
      rows[0];
    if (chosen) return getAccountRef(db, orgId, chosen.account_id);
  }

  // 2. Standard COA number fallback.
  const fallbackNumber = ROLE_DEFAULT_NUMBER[role];
  const byNumber = await accountByNumber(db, orgId, fallbackNumber, locationId);
  if (byNumber) return byNumber;

  // 3. Refuse to guess.
  throw new PostingError(
    `Unresolved account role "${role}". Map it on the Account Roles screen ` +
      `or seed account number ${fallbackNumber} in this tenant's chart of accounts.`
  );
}

/**
 * Resolve the cash-side account for a payment rail (Spec Part A.3). The rail
 * decides which account offsets an expense/revenue; the obligation rails
 * (on_account) are handled by the template via AP_CONTROL / AR_CONTROL.
 */
export async function resolveCashSide(
  db: DB,
  orgId: string,
  rail: PaymentRail,
  locationId: string
): Promise<AccountRef> {
  switch (rail) {
    case 'cash':
      return resolveRole(db, orgId, 'CASH_ON_HAND', locationId);
    case 'check':
    case 'ach':
    case 'wire':
    case 'debit_card':
      return resolveRole(db, orgId, 'OPERATING_BANK', locationId);
    case 'credit_card':
      return resolveRole(db, orgId, 'CREDIT_CARD_PAYABLE', locationId);
    case 'on_account':
      throw new PostingError(
        'on_account is an obligation rail (AP/AR), not a cash-side account; ' +
          'the posting template resolves it directly.'
      );
    default: {
      const _never: never = rail;
      return _never;
    }
  }
}
