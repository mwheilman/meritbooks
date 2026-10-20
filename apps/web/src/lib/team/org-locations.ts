import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Keep only the location ids that are companies of `orgId`.
 *
 * Access-grant writes (public.employee_locations, core.practice_assignments) run as
 * the service role since migration 154 locked those tables to SELECT-only for
 * members. The service role bypasses RLS, so a client-supplied location id is no
 * longer implicitly checked against the caller's tenant by the database — every
 * grant writer must pass its ids through this filter first so a crafted request can
 * never attach another tenant's company to a seat in this org.
 *
 * `db` may be the caller's RLS client or the service client; the query is pinned to
 * `orgId` explicitly either way.
 */
export async function filterOrgLocationIds(
  db: SupabaseClient,
  orgId: string,
  ids: readonly string[],
): Promise<string[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const { data, error } = await db
    .schema('core')
    .from('locations')
    .select('id')
    .eq('org_id', orgId)
    .in('id', unique);
  if (error) return [];
  const valid = new Set((data ?? []).map((r: { id: string }) => r.id));
  return unique.filter((id) => valid.has(id));
}

/** True when every id in `ids` is a company of `orgId`. */
export async function allOrgLocations(
  db: SupabaseClient,
  orgId: string,
  ids: readonly string[],
): Promise<boolean> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return true;
  const valid = await filterOrgLocationIds(db, orgId, unique);
  return valid.length === unique.length;
}

/**
 * True when `employeeId` is a seat in `orgId`. Same rationale as above: assignment
 * writes (core.practice_assignments) run as the service role, so a client-supplied
 * assignee id must be confirmed to belong to the caller's tenant first.
 */
export async function isOrgEmployee(
  db: SupabaseClient,
  orgId: string,
  employeeId: string,
): Promise<boolean> {
  const { data, error } = await db
    .schema('core')
    .from('employees')
    .select('id')
    .eq('org_id', orgId)
    .eq('id', employeeId)
    .maybeSingle();
  return !error && Boolean(data);
}
