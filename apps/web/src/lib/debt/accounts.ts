/**
 * Debt posting-account resolution.
 *
 * Interest accrual / payment address accounts by ROLE — never by a hard-coded
 * number (canon §2). An instrument may carry explicit account overrides; when it
 * doesn't, we resolve:
 *
 *   - cash             -> OPERATING_BANK role (per-tenant map → 1000 default)
 *   - interest payable -> a name-matched "Interest Payable"/"Accrued Interest"
 *                         LIABILITY account, else the ACCRUED_EXPENSES role (2400)
 *   - interest expense -> a name-matched "Interest Expense" account, else COA 8000
 *   - principal debt   -> the instrument's notes-payable / LT-debt liability account
 *
 * REPORTED to the lead (account-role registry gap): there is no dedicated
 * INTEREST_EXPENSE or INTEREST_PAYABLE role in `lib/posting/account-roles.ts`
 * today, and no generic NOTES_PAYABLE role (the COA carries per-facility debt
 * accounts: 2500 Term Loan, 2530 Mortgage, 2440 Line of Credit …). Until those
 * roles exist we resolve interest expense/payable by name+type with COA fallbacks
 * and require the principal liability account to be chosen per instrument. Every
 * unresolved account throws PostingError — the engine refuses to post a guess.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PostingError, resolveRole, getAccountRef, type AccountRef } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

/** Standard COA fallbacks — documentation; resolution prefers overrides/roles. */
export const INTEREST_EXPENSE_NUMBER = '8000';
export const ACCRUED_EXPENSES_NUMBER = '2400';

interface AccountRow {
  id: string;
  account_type: string;
  account_sub_type: string;
  account_number: string;
  name: string;
}

/** First active account whose name matches, optionally constrained to types. */
async function accountByName(
  db: DB,
  orgId: string,
  pattern: string,
  types?: string[],
): Promise<AccountRef | null> {
  let q = db
    .from('accounts')
    .select('id, account_type, account_sub_type, account_number, name')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .ilike('name', pattern);
  if (types && types.length > 0) q = q.in('account_type', types);
  const { data } = await q.limit(1).maybeSingle<AccountRow>();
  if (!data) return null;
  return {
    id: data.id,
    account_type: data.account_type as AccountRef['account_type'],
    account_sub_type: data.account_sub_type as AccountRef['account_sub_type'],
    account_number: data.account_number,
  };
}

async function accountByNumber(db: DB, orgId: string, number: string): Promise<AccountRef | null> {
  const { data } = await db
    .from('accounts')
    .select('id, account_type, account_sub_type, account_number, name')
    .eq('org_id', orgId)
    .eq('account_number', number)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle<AccountRow>();
  if (!data) return null;
  return {
    id: data.id,
    account_type: data.account_type as AccountRef['account_type'],
    account_sub_type: data.account_sub_type as AccountRef['account_sub_type'],
    account_number: data.account_number,
  };
}

export interface DebtAccountOverrides {
  liabilityAccountId?: string | null;
  interestExpenseAccountId?: string | null;
  interestPayableAccountId?: string | null;
  cashAccountId?: string | null;
  locationId?: string | null;
}

export interface ResolvedDebtAccounts {
  cash: AccountRef;
  interestExpense: AccountRef;
  interestPayable: AccountRef;
  /** Notes-payable / LT-debt account. Null when not configured (payment needs it). */
  liability: AccountRef | null;
}

/**
 * Resolve the four posting accounts for a debt instrument. Overrides win, then a
 * name/type match, then the standard COA number / role, then PostingError.
 * `liability` (principal) is only required for a PAYMENT — accrual never touches it,
 * so it degrades to null here and the payment path raises a clear error if missing.
 */
export async function resolveDebtAccounts(
  db: DB,
  orgId: string,
  overrides: DebtAccountOverrides,
): Promise<ResolvedDebtAccounts> {
  // Cash — override → OPERATING_BANK role (location-scoped).
  const cash = overrides.cashAccountId
    ? await getAccountRef(db, orgId, overrides.cashAccountId)
    : await resolveRole(db, orgId, 'OPERATING_BANK', overrides.locationId ?? undefined);

  // Interest expense — override → name-matched → COA 8000.
  let interestExpense: AccountRef | null = overrides.interestExpenseAccountId
    ? await getAccountRef(db, orgId, overrides.interestExpenseAccountId)
    : (await accountByName(db, orgId, '%interest expense%', ['OTHER', 'OPEX'])) ??
      (await accountByNumber(db, orgId, INTEREST_EXPENSE_NUMBER));
  if (!interestExpense) {
    throw new PostingError(
      'No interest-expense account resolved. Set the interest-expense account on the loan, ' +
        `or seed account ${INTEREST_EXPENSE_NUMBER} (Interest Expense) in this tenant's chart of accounts.`,
    );
  }

  // Interest payable — override → name-matched liability → ACCRUED_EXPENSES role (2400).
  let interestPayable: AccountRef | null = overrides.interestPayableAccountId
    ? await getAccountRef(db, orgId, overrides.interestPayableAccountId)
    : await accountByName(db, orgId, '%interest payable%', ['LIABILITY']);
  if (!interestPayable) interestPayable = await accountByName(db, orgId, '%accrued interest%', ['LIABILITY']);
  if (!interestPayable) {
    // ACCRUED_EXPENSES is the canonical home for accrued interest in this COA.
    interestPayable = await resolveRole(db, orgId, 'ACCRUED_EXPENSES', overrides.locationId ?? undefined);
  }

  const liability = overrides.liabilityAccountId
    ? await getAccountRef(db, orgId, overrides.liabilityAccountId)
    : null;

  return { cash, interestExpense, interestPayable, liability };
}
