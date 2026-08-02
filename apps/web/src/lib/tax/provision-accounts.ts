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
 * Resolution order per account (canon §2/§3): an explicit override → the account-role registry
 * mapping (`public.account_roles`, keyed by the role in `lib/posting/account-roles.ts`) → a
 * name+type match → the standard COA number → null. An unresolved account is returned as `null`
 * (not a throw) so the provision can still be COMPUTED and PROPOSED; only POSTING requires the
 * accounts, and the post path raises a clear, itemized error naming exactly which to seed. The
 * engine never posts a guess.
 *
 * The four role keys (INCOME_TAX_EXPENSE, INCOME_TAXES_PAYABLE, DEFERRED_TAX_ASSET,
 * DEFERRED_TAX_LIABILITY) now live in the registry. The registry's mapping table has to be seeded
 * per tenant (a reserved migration — reported to the lead); until then this resolver still lands
 * the right account by name/number, and once seeded the mapping tier wins.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAccountRef,
  ROLE_DEFAULT_NUMBER,
  type AccountRef,
  type AccountRoleKey,
} from '@/lib/posting/account-roles';

type DB = SupabaseClient;

/**
 * Standard COA fallbacks for the provision accounts (documentation + resolution fallback).
 * Sourced from the account-role registry so the number-fallback tier can never drift from it.
 * NOTE: payable (2280) and DTA (1750) deliberately avoid the standard-COA collisions 2260
 * (Accrued Wages) and 1700 (Goodwill); the seeding migration creates those accounts.
 */
export const INCOME_TAX_EXPENSE_NUMBER = ROLE_DEFAULT_NUMBER.INCOME_TAX_EXPENSE;
export const INCOME_TAXES_PAYABLE_NUMBER = ROLE_DEFAULT_NUMBER.INCOME_TAXES_PAYABLE;
export const DEFERRED_TAX_ASSET_NUMBER = ROLE_DEFAULT_NUMBER.DEFERRED_TAX_ASSET;
export const DEFERRED_TAX_LIABILITY_NUMBER = ROLE_DEFAULT_NUMBER.DEFERRED_TAX_LIABILITY;

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

/**
 * Account-role registry mapping (`public.account_roles`) for a role key — the tenant's explicit
 * choice, which wins over any name/number heuristic. Returns null (never throws) when the role
 * isn't mapped, so resolution degrades to the name/number tiers.
 */
async function accountByRole(db: DB, orgId: string, role: AccountRoleKey): Promise<AccountRef | null> {
  const { data } = await db
    .from('account_roles')
    .select('account_id')
    .eq('org_id', orgId)
    .eq('role_key', role)
    .is('location_id', null)
    .limit(1)
    .maybeSingle<{ account_id: string }>();
  if (!data?.account_id) return null;
  try {
    return await getAccountRef(db, orgId, data.account_id);
  } catch {
    return null;
  }
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
    : (await accountByRole(db, orgId, 'INCOME_TAX_EXPENSE')) ??
      (await accountByName(db, orgId, '%income tax%', ['OPEX', 'OTHER'])) ??
      (await accountByNumber(db, orgId, INCOME_TAX_EXPENSE_NUMBER));

  const incomeTaxesPayable = overrides.incomeTaxesPayableAccountId
    ? await getAccountRef(db, orgId, overrides.incomeTaxesPayableAccountId)
    : (await accountByRole(db, orgId, 'INCOME_TAXES_PAYABLE')) ??
      (await accountByName(db, orgId, '%income tax%payable%', ['LIABILITY'])) ??
      (await accountByName(db, orgId, '%income taxes payable%', ['LIABILITY'])) ??
      (await accountByNumber(db, orgId, INCOME_TAXES_PAYABLE_NUMBER));

  const deferredTaxAsset = overrides.deferredTaxAssetAccountId
    ? await getAccountRef(db, orgId, overrides.deferredTaxAssetAccountId)
    : (await accountByRole(db, orgId, 'DEFERRED_TAX_ASSET')) ??
      (await accountByName(db, orgId, '%deferred tax asset%', ['ASSET'])) ??
      (await accountByNumber(db, orgId, DEFERRED_TAX_ASSET_NUMBER));

  const deferredTaxLiability = overrides.deferredTaxLiabilityAccountId
    ? await getAccountRef(db, orgId, overrides.deferredTaxLiabilityAccountId)
    : (await accountByRole(db, orgId, 'DEFERRED_TAX_LIABILITY')) ??
      (await accountByName(db, orgId, '%deferred tax liab%', ['LIABILITY'])) ??
      (await accountByNumber(db, orgId, DEFERRED_TAX_LIABILITY_NUMBER));

  const missing: string[] = [];
  if (!incomeTaxExpense) missing.push(`Income Tax Expense (seed account ${INCOME_TAX_EXPENSE_NUMBER})`);
  if (!incomeTaxesPayable) missing.push(`Income Taxes Payable (seed account ${INCOME_TAXES_PAYABLE_NUMBER})`);
  if (!deferredTaxAsset) missing.push(`Deferred Tax Asset (seed account ${DEFERRED_TAX_ASSET_NUMBER})`);
  if (!deferredTaxLiability) missing.push(`Deferred Tax Liability (seed account ${DEFERRED_TAX_LIABILITY_NUMBER})`);

  return { incomeTaxExpense, incomeTaxesPayable, deferredTaxAsset, deferredTaxLiability, missing };
}
