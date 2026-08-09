/**
 * Resolve the two legs of an insurance premium amortization by ROLE (canon §3 —
 * accounts are addressed by role, never a hard-coded number):
 *
 *   - CR leg: PREPAID_INSURANCE (asset) — the prepaid premium carried on the BS.
 *   - DR leg: INSURANCE_EXPENSE — the P&L account the premium amortizes into.
 *
 * Both roles live in the canonical registry (`lib/posting/account-roles.ts`,
 * seeded into core.account_role_keys by migration 132). Resolution degrades exactly
 * the way the registry does — explicit `account_roles` mapping → standard COA number
 * → a name heuristic → null (never a guess). All reads run through the RLS-scoped
 * client, so org isolation is the database's job. These NEVER throw: a lookup miss
 * resolves to null so the setup path can ask the human to pick the account.
 *
 * Smart default: the expense leg is coverage-type-aware. The standard COA carries
 * distinct insurance expense accounts (property 6720, professional 6710, umbrella
 * 6730, auto 6220, workers-comp 6040); when the policy's coverage type has one, we
 * prefer it, falling back to the INSURANCE_EXPENSE role default (6700).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLE_DEFAULT_NUMBER } from '@/lib/posting/account-roles';

export interface ResolvedAccount {
  id: string;
  name: string;
  account_number: string | null;
  account_type: string;
}

const PREPAID_INSURANCE_ROLE = 'PREPAID_INSURANCE';
const INSURANCE_EXPENSE_ROLE = 'INSURANCE_EXPENSE';

const PREPAID_INSURANCE_FALLBACK = ROLE_DEFAULT_NUMBER.PREPAID_INSURANCE; // '1300'
const INSURANCE_EXPENSE_FALLBACK = ROLE_DEFAULT_NUMBER.INSURANCE_EXPENSE; // '6700'

const PREPAID_INSURANCE_NAME_RE = /prepaid\s+insurance/i;
const INSURANCE_EXPENSE_NAME_RE = /insurance/i;

/**
 * Coverage-type → preferred standard-COA expense account number. A tenant that
 * hasn't remapped the INSURANCE_EXPENSE role still books property to Property
 * Insurance, auto to Vehicle Insurance, etc., rather than lumping everything into
 * General Liability. Falls back to the role default when the number isn't present.
 */
const COVERAGE_EXPENSE_NUMBER: Record<string, string> = {
  GL: '6700',
  PROPERTY: '6720',
  PROFESSIONAL: '6710',
  UMBRELLA: '6730',
  AUTO: '6220',
  WC: '6040',
  CYBER: '6700',
  OTHER: '6700',
};

async function fetchAccountById(db: SupabaseClient, id: string): Promise<ResolvedAccount | null> {
  const { data } = await db
    .from('accounts')
    .select('id, name, account_number, account_type')
    .eq('id', id)
    .maybeSingle<ResolvedAccount>();
  return data ?? null;
}

async function fetchAccountByNumber(db: SupabaseClient, number: string): Promise<ResolvedAccount | null> {
  const { data } = await db
    .from('accounts')
    .select('id, name, account_number, account_type')
    .eq('account_number', number)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle<ResolvedAccount>();
  return data ?? null;
}

/** An explicit account_roles mapping (location-specific row wins), else null. */
async function fetchRoleMapping(
  db: SupabaseClient,
  roleKey: string,
  locationId?: string | null,
): Promise<ResolvedAccount | null> {
  try {
    const { data: maps } = await db
      .from('account_roles')
      .select('account_id, location_id')
      .eq('role_key', roleKey);
    const rows = (maps ?? []) as { account_id: string; location_id: string | null }[];
    if (rows.length === 0) return null;
    const chosen =
      (locationId && rows.find((r) => r.location_id === locationId)) ||
      rows.find((r) => r.location_id === null) ||
      rows[0];
    return chosen ? fetchAccountById(db, chosen.account_id) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Prepaid-Insurance ASSET account (CR leg). `locationId` selects a
 * location-scoped role row. Never throws.
 */
export async function resolvePrepaidInsuranceAccount(
  db: SupabaseClient,
  locationId?: string | null,
): Promise<ResolvedAccount | null> {
  // 1. Explicit role mapping.
  const mapped = await fetchRoleMapping(db, PREPAID_INSURANCE_ROLE, locationId);
  if (mapped) return mapped;

  // 2. Standard COA number (1300 "Prepaid Insurance").
  const byNumber = await fetchAccountByNumber(db, PREPAID_INSURANCE_FALLBACK);
  if (byNumber) return byNumber;

  // 3. Name heuristic over ASSET accounts ("Prepaid Insurance").
  try {
    const { data } = await db
      .from('accounts')
      .select('id, name, account_number, account_type')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .order('account_number');
    const assets = (data ?? []) as ResolvedAccount[];
    const match = assets.find((a) => PREPAID_INSURANCE_NAME_RE.test(a.name));
    if (match) return match;
  } catch {
    /* fall through */
  }

  return null;
}

/**
 * Resolve the Insurance-Expense account (DR leg) for a coverage type. `locationId`
 * selects a location-scoped role row. Never throws.
 */
export async function resolveInsuranceExpenseAccount(
  db: SupabaseClient,
  coverageType?: string | null,
  locationId?: string | null,
): Promise<ResolvedAccount | null> {
  // 1. Explicit role mapping wins — the tenant told us where insurance expense goes.
  const mapped = await fetchRoleMapping(db, INSURANCE_EXPENSE_ROLE, locationId);
  if (mapped) return mapped;

  // 2. Coverage-type-aware standard COA number (property/auto/etc.), then the role
  //    default 6700.
  const preferred = (coverageType && COVERAGE_EXPENSE_NUMBER[coverageType]) || INSURANCE_EXPENSE_FALLBACK;
  const byPreferred = await fetchAccountByNumber(db, preferred);
  if (byPreferred) return byPreferred;
  if (preferred !== INSURANCE_EXPENSE_FALLBACK) {
    const byDefault = await fetchAccountByNumber(db, INSURANCE_EXPENSE_FALLBACK);
    if (byDefault) return byDefault;
  }

  // 3. Name heuristic over expense accounts.
  try {
    const { data } = await db
      .from('accounts')
      .select('id, name, account_number, account_type')
      .in('account_type', ['OPEX', 'EXPENSE'])
      .eq('is_active', true)
      .order('account_number');
    const rows = (data ?? []) as ResolvedAccount[];
    const match = rows.find((a) => INSURANCE_EXPENSE_NAME_RE.test(a.name));
    if (match) return match;
  } catch {
    /* fall through */
  }

  return null;
}
