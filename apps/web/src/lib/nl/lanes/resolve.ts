/**
 * Server-only entity resolution for the PROCESSING draft lanes (P3/P4).
 *
 * Turns the model's free-text names ("Acme", "job supplies") into real ids the
 * draft form pre-selects. All reads go through the caller's RLS-scoped client, so
 * a name only ever resolves within the caller's own tenant — never a cross-tenant
 * reach. A miss returns null and the form falls back to a picker (never a guess).
 *
 * Server-only — never import into a client component.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface NameMatch {
  id: string;
  name: string;
  confidence: number;
}

interface CoreParty {
  id: string;
  name: string;
  display_name: string | null;
}

/** Exact-then-fuzzy match a name against a `core` party table (vendors/customers). */
async function resolveParty(
  supabase: SupabaseClient,
  table: 'vendors' | 'customers',
  name: string,
): Promise<NameMatch | null> {
  const exact = await supabase.schema('core').from(table)
    .select('id, name, display_name').ilike('name', name).limit(1);
  const exactRows = (exact.data ?? []) as CoreParty[];
  if (exactRows.length > 0) {
    const v = exactRows[0];
    return { id: v.id, name: v.display_name ?? v.name, confidence: 1 };
  }
  for (const word of name.split(/\s+/).filter((w) => w.length >= 3)) {
    const fuzzy = await supabase.schema('core').from(table)
      .select('id, name, display_name').ilike('name', `%${word}%`).limit(1);
    const rows = (fuzzy.data ?? []) as CoreParty[];
    if (rows.length > 0) {
      const v = rows[0];
      return { id: v.id, name: v.display_name ?? v.name, confidence: 0.6 };
    }
  }
  return null;
}

export function resolveVendorByName(supabase: SupabaseClient, name: string): Promise<NameMatch | null> {
  return resolveParty(supabase, 'vendors', name);
}

export function resolveCustomerByName(supabase: SupabaseClient, name: string): Promise<NameMatch | null> {
  return resolveParty(supabase, 'customers', name);
}

interface AccountRow {
  id: string;
  account_number: string;
  name: string;
}

/**
 * Resolve a free-text account hint to ONE approved, active GL account, biased to
 * the given account_type family (expense/COGS for a bill, revenue for an invoice).
 */
export async function resolveAccountByHint(
  supabase: SupabaseClient,
  hint: string,
  accountTypes: string[],
): Promise<{ id: string; label: string } | null> {
  let query = supabase
    .from('accounts')
    .select('id, account_number, name')
    .eq('is_active', true)
    .eq('approval_status', 'APPROVED');
  // An empty list means "any type" (P2 coding, where the user names the account).
  if (accountTypes.length > 0) query = query.in('account_type', accountTypes);
  const { data } = await query.ilike('name', `%${hint}%`).limit(1);
  const rows = (data ?? []) as AccountRow[];
  const a = rows[0];
  return a ? { id: a.id, label: `${a.account_number} · ${a.name}` } : null;
}

/** Fetch `id → "1234 · Name"` labels for a set of account ids (RLS-scoped). */
export async function fetchAccountLabels(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return map;
  const { data } = await supabase.from('accounts').select('id, account_number, name').in('id', unique);
  for (const a of (data ?? []) as AccountRow[]) {
    map.set(a.id, `${a.account_number} · ${a.name}`);
  }
  return map;
}

/** Pre-select the company when the tenant has exactly one location; else null. */
export async function defaultLocationId(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase.schema('core').from('locations').select('id').limit(2);
  const rows = (data ?? []) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0].id : null;
}
