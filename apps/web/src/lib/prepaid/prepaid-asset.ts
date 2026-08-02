/**
 * Resolve the tenant's Prepaid-Expenses ASSET account — the credit leg of a
 * prepaid amortization (DR Expense / CR Prepaid Asset).
 *
 * Canon §3: accounts are referenced by ROLE, never by a hard-coded number. The
 * PREPAID_ASSET role now lives in the canonical registry (`lib/posting/account-roles.ts`),
 * so this resolver degrades exactly the way the registry does:
 *
 *   1. an explicit `account_roles` mapping keyed `role_key = 'PREPAID_ASSET'`
 *      (a location-specific row wins over an org-wide one), then
 *   2. an ASSET account whose name reads as a prepaid account (/prepaid/i), then
 *   3. the role's standard COA number (registry default) as a last resort, then
 *   4. null — the caller degrades (the setup UI asks the human to pick the account
 *      explicitly) rather than posting a guess.
 *
 * Reads run through the RLS-scoped client, so org isolation is the database's job.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLE_DEFAULT_NUMBER } from '@/lib/posting/account-roles';

/** The role key this module resolves — kept in sync with the registry key. */
export const PREPAID_ASSET_ROLE = 'PREPAID_ASSET';

/** Standard COA number fallback for the prepaid-asset role (registry default). */
const PREPAID_ASSET_FALLBACK_NUMBER = ROLE_DEFAULT_NUMBER.PREPAID_ASSET;

export interface ResolvedAccount {
  id: string;
  name: string;
  account_number: string | null;
  account_type: string;
}

const PREPAID_NAME_RE = /prepaid/i;

/**
 * Resolve the prepaid-asset account for `orgId`, or null when the tenant hasn't
 * mapped/created one. `locationId` (optional) selects a location-scoped role row.
 * Never throws — a lookup failure resolves to null so setup can still proceed with
 * an explicit human pick.
 */
export async function resolvePrepaidAssetAccount(
  supabase: SupabaseClient,
  locationId?: string | null,
): Promise<ResolvedAccount | null> {
  // 1. Explicit account_roles mapping.
  try {
    const { data: maps } = await supabase
      .from('account_roles')
      .select('account_id, location_id')
      .eq('role_key', PREPAID_ASSET_ROLE);
    const rows = (maps ?? []) as { account_id: string; location_id: string | null }[];
    if (rows.length > 0) {
      const chosen =
        (locationId && rows.find((r) => r.location_id === locationId)) ||
        rows.find((r) => r.location_id === null) ||
        rows[0];
      if (chosen) {
        const acct = await fetchAccount(supabase, chosen.account_id);
        if (acct) return acct;
      }
    }
  } catch {
    /* mapping table best-effort — fall through to the name heuristic */
  }

  // 2. Name heuristic over ASSET accounts.
  try {
    const { data } = await supabase
      .from('accounts')
      .select('id, name, account_number, account_type')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .order('account_number');
    const assets = (data ?? []) as ResolvedAccount[];
    const match = assets.find((a) => PREPAID_NAME_RE.test(a.name));
    if (match) return match;
  } catch {
    /* fall through to the number fallback */
  }

  // 3. Standard COA number fallback (registry default), retained as a last resort
  //    so a tenant that hasn't mapped the role still resolves.
  try {
    const { data } = await supabase
      .from('accounts')
      .select('id, name, account_number, account_type')
      .eq('account_number', PREPAID_ASSET_FALLBACK_NUMBER)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle<ResolvedAccount>();
    if (data) return data;
  } catch {
    /* fall through to null */
  }

  // 4. Unresolved — the human picks explicitly.
  return null;
}

async function fetchAccount(supabase: SupabaseClient, accountId: string): Promise<ResolvedAccount | null> {
  const { data } = await supabase
    .from('accounts')
    .select('id, name, account_number, account_type')
    .eq('id', accountId)
    .maybeSingle<ResolvedAccount>();
  return data ?? null;
}
