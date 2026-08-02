/**
 * Provision posting-account resolution (ASC 740).
 *
 * The provision JE addresses four accounts BY ROLE (canon §2) — never a hard-coded number:
 *
 *   - income tax expense       → a name-matched "Income Tax(es) Expense" P&L account
 *                                (OPEX / OTHER), else COA 8100
 *   - income taxes payable     → a name-matched "Income Tax(es) Payable" LIABILITY account,
 *                                else COA 2260
 *   - deferred tax asset       → a name-matched "Deferred Tax Asset" ASSET account, else COA 1700
 *   - deferred tax liability   → a name-matched "Deferred Tax Liability" LIABILITY account,
 *                                else COA 2700
 *
 * REPORTED to the lead (account-role registry gap): there are NO dedicated INCOME_TAX_EXPENSE,
 * INCOME_TAXES_PAYABLE, DEFERRED_TAX_ASSET, or DEFERRED_TAX_LIABILITY role keys in
 * `lib/posting/account-roles.ts` (a reserved-spine file). Until those roles exist we resolve by
 * name+type with the COA fallbacks above. An unresolved account is returned as `null` (not a
 * throw) so the provision can still be COMPUTED and PROPOSED; only POSTING requires the
 * accounts, and the post path raises a clear, itemized error naming exactly which to seed.
 * The engine never posts a guess.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountRef, type AccountRef } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

/** Standard COA fallbacks for the provision accounts (documentation + resolution fallback). */
export const INCOME_TAX_EXPENSE_NUMBER = '8100';
export const INCOME_TAXES_PAYABLE_NUMBER = '2260';
export const DEFERRED_TAX_ASSET_NUMBER = '1700';
export const DEFERRED_TAX_LIABILITY_NUMBER = '2700';

interface AccountRow {
  id: string;
  account_type: string;
  account_sub_type: string;
  account_number: string;
  name: string;
}

function toRef(row: AccountRow): AccountRef {
  return {
    id: row.id,
    account_type: row.account_type as AccountRef['account_type'],
    account_sub_type: row.account_sub_type as AccountRef['account_sub_type'],
    account_number: row.account_number,
  };
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
  return data ? toRef(data) : null;
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
  return data ? toRef(data) : null;
}

export interface ProvisionAccountOverrides {
  incomeTaxExpenseAccountId?: string | null;
  incomeTaxesPayableAccountId?: string | null;
  deferredTaxAssetAccountId?: string | null;
  deferredTaxLiabilityAccountId?: string | null;
}

export interface ResolvedProvisionAccounts {
  incomeTaxExpense: AccountRef | null;
  incomeTaxesPayable: AccountRef | null;
  deferredTaxAsset: AccountRef | null;
  deferredTaxLiability: AccountRef | null;
  /** Human-readable role keys that could not be resolved (for a clear "seed these" message). */
  missing: string[];
}

/**
 * Resolve the four provision accounts. Overrides win, then a name match, then the standard COA
 * number, else null (recorded in `missing`). Never throws — the caller decides whether the
 * unresolved set blocks the post it's attempting.
 */
export async function resolveProvisionAccounts(
  db: DB,
  orgId: string,
  overrides: ProvisionAccountOverrides = {},
): Promise<ResolvedProvisionAccounts> {
  const incomeTaxExpense = overrides.incomeTaxExpenseAccountId
    ? await getAccountRef(db, orgId, overrides.incomeTaxExpenseAccountId)
    : (await accountByName(db, orgId, '%income tax%', ['OPEX', 'OTHER'])) ??
      (await accountByNumber(db, orgId, INCOME_TAX_EXPENSE_NUMBER));

  const incomeTaxesPayable = overrides.incomeTaxesPayableAccountId
    ? await getAccountRef(db, orgId, overrides.incomeTaxesPayableAccountId)
    : (await accountByName(db, orgId, '%income tax%payable%', ['LIABILITY'])) ??
      (await accountByName(db, orgId, '%income taxes payable%', ['LIABILITY'])) ??
      (await accountByNumber(db, orgId, INCOME_TAXES_PAYABLE_NUMBER));

  const deferredTaxAsset = overrides.deferredTaxAssetAccountId
    ? await getAccountRef(db, orgId, overrides.deferredTaxAssetAccountId)
    : (await accountByName(db, orgId, '%deferred tax asset%', ['ASSET'])) ??
      (await accountByNumber(db, orgId, DEFERRED_TAX_ASSET_NUMBER));

  const deferredTaxLiability = overrides.deferredTaxLiabilityAccountId
    ? await getAccountRef(db, orgId, overrides.deferredTaxLiabilityAccountId)
    : (await accountByName(db, orgId, '%deferred tax liab%', ['LIABILITY'])) ??
      (await accountByNumber(db, orgId, DEFERRED_TAX_LIABILITY_NUMBER));

  const missing: string[] = [];
  if (!incomeTaxExpense) missing.push(`Income Tax Expense (seed account ${INCOME_TAX_EXPENSE_NUMBER})`);
  if (!incomeTaxesPayable) missing.push(`Income Taxes Payable (seed account ${INCOME_TAXES_PAYABLE_NUMBER})`);
  if (!deferredTaxAsset) missing.push(`Deferred Tax Asset (seed account ${DEFERRED_TAX_ASSET_NUMBER})`);
  if (!deferredTaxLiability) missing.push(`Deferred Tax Liability (seed account ${DEFERRED_TAX_LIABILITY_NUMBER})`);

  return { incomeTaxExpense, incomeTaxesPayable, deferredTaxAsset, deferredTaxLiability, missing };
}
