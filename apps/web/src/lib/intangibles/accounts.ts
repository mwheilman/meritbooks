/**
 * Intangible-asset account-role resolution.
 *
 * Amortization posts by ROLE, never by a hard-coded number (canon §3). The shared
 * engine registry (`lib/posting/account-roles.ts`) does not carry the intangible
 * families and that file is reserved (the lead owns it), so — exactly like the
 * leases module (`lib/leases/lease-accounts.ts`) — this module-scoped resolver
 * resolves the intangible roles the SAME way `resolveRole` does:
 *
 *   1. `public.account_roles` mapping for the role_key (a location row wins over org-wide)
 *   2. the role's standard COA number (present in the seed template) as fallback
 *   3. PostingError — refuse to guess; stop with a clear, actionable message.
 *
 * The four fallback numbers all exist in the seed chart of accounts template
 * (`packages/shared/src/constants/chart-of-accounts.ts`): 1710 Other Intangibles,
 * 1700 Goodwill, 1720 Accum Amortization, 6810 Amortization Expense. So a seeded
 * tenant resolves every role OUT OF THE BOX with no migration.
 *
 * REPORTED to the lead (registry gap, not a blocker): to make these roles
 * REMAPPABLE on the Account Roles screen, register them in
 * `core.account_role_keys` (mirroring what migration 082 did for the lease roles).
 * Until then resolution degrades gracefully to the COA-number fallback above.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountRef, PostingError, type AccountRef } from '@/lib/posting/account-roles';
import { isNonAmortizing } from './categories';

type DB = SupabaseClient;

/** Intangible-specific account roles (new families layered on the engine registry). */
export type IntangibleRoleKey =
  | 'INTANGIBLE_ASSET' // finite-lived intangible cost account
  | 'GOODWILL' // goodwill cost account (non-amortizing)
  | 'ACCUMULATED_AMORTIZATION' // contra-asset
  | 'AMORTIZATION_EXPENSE'; // P&L expense

/** Standard COA numbers per intangible role — the fallback when account_roles isn't mapped. */
export const INTANGIBLE_ROLE_DEFAULT_NUMBER: Record<IntangibleRoleKey, string> = {
  INTANGIBLE_ASSET: '1710', // Other Intangibles
  GOODWILL: '1700', // Goodwill
  ACCUMULATED_AMORTIZATION: '1720', // Accum Amortization (contra-asset)
  AMORTIZATION_EXPENSE: '6810', // Amortization Expense
};

interface AccountRow {
  id: string;
}

async function accountIdByNumber(
  db: DB,
  orgId: string,
  number: string,
  locationId?: string,
): Promise<string | null> {
  let query = db
    .from('accounts')
    .select('id, company_location_id')
    .eq('org_id', orgId)
    .eq('account_number', number)
    .eq('is_active', true);
  if (locationId) query = query.or(`company_location_id.eq.${locationId},company_location_id.is.null`);
  const { data } = await query.limit(1).maybeSingle<AccountRow>();
  return data?.id ?? null;
}

/**
 * Resolve an intangible role to the tenant's real account. `locationId` prefers a
 * location-scoped mapping / company-specific account. Throws PostingError (degrade)
 * when the role is neither mapped nor seeded — so the caller reports it, never guesses.
 */
export async function resolveIntangibleRole(
  db: DB,
  orgId: string,
  role: IntangibleRoleKey,
  locationId?: string,
): Promise<AccountRef> {
  // 1. Explicit account_roles mapping (location-specific wins over org-wide).
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

  // 2. Standard COA number fallback (present in the seed template).
  const fallbackNumber = INTANGIBLE_ROLE_DEFAULT_NUMBER[role];
  const byNumber = await accountIdByNumber(db, orgId, fallbackNumber, locationId);
  if (byNumber) return getAccountRef(db, orgId, byNumber);

  // 3. Refuse to guess — degrade with an actionable message.
  throw new PostingError(
    `Unresolved intangible account role "${role}". Map it on the Account Roles screen ` +
      `or seed account number ${fallbackNumber} in this tenant's chart of accounts.`,
  );
}

export interface ResolvedIntangibleAccounts {
  /** Cost account (1700 goodwill / 1710 finite-lived intangible). */
  asset: AccountRef;
  /** Amortization expense account (P&L). */
  amortizationExpense: AccountRef;
  /** Accumulated amortization contra-asset account. */
  accumulatedAmortization: AccountRef;
}

/**
 * Resolve the three posting accounts an intangible needs. The cost account depends
 * on the category (goodwill → GOODWILL role/1700, everything else → INTANGIBLE_ASSET
 * role/1710). Every account resolves by role with a COA-number fallback, or throws.
 */
export async function resolveIntangibleAccounts(
  db: DB,
  orgId: string,
  category: string,
  locationId?: string,
): Promise<ResolvedIntangibleAccounts> {
  const assetRole: IntangibleRoleKey = isNonAmortizing(category) ? 'GOODWILL' : 'INTANGIBLE_ASSET';
  const [asset, amortizationExpense, accumulatedAmortization] = await Promise.all([
    resolveIntangibleRole(db, orgId, assetRole, locationId),
    resolveIntangibleRole(db, orgId, 'AMORTIZATION_EXPENSE', locationId),
    resolveIntangibleRole(db, orgId, 'ACCUMULATED_AMORTIZATION', locationId),
  ]);
  return { asset, amortizationExpense, accumulatedAmortization };
}
