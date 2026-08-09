/**
 * Onboarding ownership — WHO on the practice team owns bringing a client company
 * onto the books.
 *
 * It rides the SAME ownership grid as the portfolio functions (close / ar / ap /
 * review): one row per (org, location) with function = 'onboarding' in
 * core.practice_assignments (migration 121). One owner per company. The Team & Access
 * dialog writes it member-first ("this person owns onboarding for these companies");
 * the Entities board writes it company-first ("this company's onboarding owner is X").
 * Both land in the same authoritative place.
 *
 * DEGRADE-SAFE throughout: if the practice_assignments table / the 'onboarding'
 * function / the locations.onboarding_status column aren't present yet, every helper
 * silently no-ops (or reports unavailable) — nothing here can 500 a Team or Entities
 * surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ADMIN_SCOPE_COLUMN, isMissingScopeColumn, parseAdminScope } from '@/lib/team/admin-scope';

export const ONBOARDING_FUNCTION = 'onboarding' as const;

/** location_id → owning employee_id, for the onboarding function only. */
export async function loadOnboardingOwners(
  supabase: SupabaseClient,
): Promise<{ available: boolean; byLocation: Map<string, string> }> {
  const byLocation = new Map<string, string>();
  const { data, error } = await supabase
    .schema('core')
    .from('practice_assignments')
    .select('location_id, assignee_employee_id, function')
    .eq('function', ONBOARDING_FUNCTION)
    .limit(5000);
  if (error) return { available: false, byLocation };
  for (const r of (data ?? []) as Array<{ location_id: string; assignee_employee_id: string | null }>) {
    if (r.location_id && r.assignee_employee_id) byLocation.set(r.location_id, r.assignee_employee_id);
  }
  return { available: true, byLocation };
}

/** Which companies does THIS employee currently own onboarding for? */
export async function loadOnboardingCompaniesForEmployee(
  supabase: SupabaseClient,
  orgId: string,
  employeeId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .schema('core')
    .from('practice_assignments')
    .select('location_id')
    .eq('org_id', orgId)
    .eq('function', ONBOARDING_FUNCTION)
    .eq('assignee_employee_id', employeeId);
  if (error) return [];
  return (data ?? []).map((r: { location_id: string }) => r.location_id);
}

/**
 * Set `employeeId` as the onboarding owner of exactly `locationIds` (member-first).
 * Companies they no longer own are released (row deleted → unassigned); companies in
 * the list are upserted to them. Returns whether the write path was available.
 * DEGRADE-SAFE: any table/constraint error → { applied:false } with no throw.
 */
export async function setEmployeeOnboardingCompanies(
  supabase: SupabaseClient,
  orgId: string,
  employeeId: string,
  locationIds: string[],
): Promise<{ applied: boolean }> {
  const want = new Set(locationIds);

  // Release companies this employee owns but shouldn't any more.
  const current = await loadOnboardingCompaniesForEmployee(supabase, orgId, employeeId);
  const toRelease = current.filter((id) => !want.has(id));
  if (toRelease.length > 0) {
    const { error } = await supabase
      .schema('core')
      .from('practice_assignments')
      .delete()
      .eq('org_id', orgId)
      .eq('function', ONBOARDING_FUNCTION)
      .eq('assignee_employee_id', employeeId)
      .in('location_id', toRelease);
    if (error) return { applied: false };
  }

  // Assign (upsert) the requested companies to this employee.
  if (locationIds.length > 0) {
    const rows = locationIds.map((location_id) => ({
      org_id: orgId,
      location_id,
      function: ONBOARDING_FUNCTION,
      assignee_employee_id: employeeId,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .schema('core')
      .from('practice_assignments')
      .upsert(rows, { onConflict: 'org_id,location_id,function' });
    if (error) return { applied: false };
    // Nudge freshly-owned companies from not_started → in_progress (best-effort).
    await markOnboardingInProgress(supabase, orgId, locationIds);
  }

  return { applied: true };
}

/**
 * Merge PREPARER into an employee's admin_scope capability set (they now do the
 * onboarding data entry for at least one company). Never widens beyond PREPARER and
 * never drops an existing capability. Best-effort + degrade-safe (column may be
 * absent). A no-op when they already carry PREPARER or full (null) scope.
 */
export async function ensurePreparerCapability(
  supabase: SupabaseClient,
  orgId: string,
  employeeId: string,
): Promise<void> {
  const { data, error } = await supabase
    .schema('core')
    .from('employees')
    .select(`id, ${ADMIN_SCOPE_COLUMN}`)
    .eq('id', employeeId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    if (isMissingScopeColumn(error)) return; // column not migrated — nothing to store
    return;
  }
  const current = parseAdminScope((data as Record<string, unknown> | null)?.[ADMIN_SCOPE_COLUMN]);
  // null = full admin (already can prepare); PREPARER present = nothing to do.
  if (current === null || current.includes('PREPARER')) return;
  const next = Array.from(new Set([...current, 'PREPARER']));
  await supabase
    .schema('core')
    .from('employees')
    .update({ [ADMIN_SCOPE_COLUMN]: next })
    .eq('id', employeeId)
    .eq('org_id', orgId);
}

/** Move companies from not_started → in_progress (leaves in_progress / complete alone). */
export async function markOnboardingInProgress(
  supabase: SupabaseClient,
  orgId: string,
  locationIds: string[],
): Promise<void> {
  if (locationIds.length === 0) return;
  await supabase
    .schema('core')
    .from('locations')
    .update({ onboarding_status: 'in_progress' })
    .eq('org_id', orgId)
    .in('id', locationIds)
    .eq('onboarding_status', 'not_started');
}
