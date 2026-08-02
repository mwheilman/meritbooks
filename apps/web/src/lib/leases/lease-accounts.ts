/**
 * Lease account-role resolution.
 *
 * ASC 842 posting addresses accounts by ROLE, never by a hard-coded number. The
 * shared engine registry (`lib/posting/account-roles.ts`) does not yet carry the
 * lease families, and that file is reserved (the lead owns it), so this resolver —
 * scoped to the leases module — resolves the lease roles the SAME way `resolveRole`
 * does, then defers to `getAccountRef` for the type/sub-type the direction helper
 * needs:
 *
 *   1. public.account_roles mapping for the role_key (a location row wins over org-wide)
 *   2. the role's standard COA number (seeded by migration 082 into every tenant)
 *   3. PostingError — refuse to guess; stop with a clear, actionable message.
 *
 * Migration 082 registers these role_keys in `core.account_role_keys` and seeds the
 * two NEW accounts (Right-of-Use Asset 1580, Lease Liability 2550) into each org's
 * COA, so a seeded tenant resolves all five roles out of the box. If a tenant has
 * not been seeded, resolution DEGRADES to a PostingError naming the role + number.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountRef, PostingError, type AccountRef } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

/** Lease-specific account roles (new families layered on the engine registry). */
export type LeaseRoleKey =
  | 'ROU_ASSET'
  | 'LEASE_LIABILITY'
  | 'LEASE_EXPENSE'
  | 'LEASE_INTEREST_EXPENSE'
  | 'ROU_AMORTIZATION_EXPENSE';

/** Standard COA numbers per lease role — the fallback when account_roles isn't mapped. */
const LEASE_ROLE_DEFAULT_NUMBER: Record<LeaseRoleKey, string> = {
  ROU_ASSET: '1580', // Right-of-Use Asset (Lease) — seeded by migration 082
  LEASE_LIABILITY: '2550', // Lease Liability (ASC 842) — seeded by migration 082
  LEASE_EXPENSE: '6100', // Rent (operating single-line lease expense)
  LEASE_INTEREST_EXPENSE: '8000', // Interest Expense (finance lease)
  ROU_AMORTIZATION_EXPENSE: '6810', // Amortization Expense (finance lease)
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
 * Resolve a lease role to the tenant's real account. `locationId` is used to prefer
 * a location-scoped mapping / company-specific account. Throws PostingError (degrade)
 * when the role is neither mapped nor seeded — so the caller reports it, never guesses.
 */
export async function resolveLeaseRole(
  db: DB,
  orgId: string,
  role: LeaseRoleKey,
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

  // 2. Standard COA number fallback (seeded by migration 082).
  const fallbackNumber = LEASE_ROLE_DEFAULT_NUMBER[role];
  const byNumber = await accountIdByNumber(db, orgId, fallbackNumber, locationId);
  if (byNumber) return getAccountRef(db, orgId, byNumber);

  // 3. Refuse to guess — degrade with an actionable message.
  throw new PostingError(
    `Unresolved lease account role "${role}". Map it on the Account Roles screen ` +
      `or seed account number ${fallbackNumber} in this tenant's chart of accounts ` +
      `(migration 082 seeds it for new tenants).`,
  );
}
