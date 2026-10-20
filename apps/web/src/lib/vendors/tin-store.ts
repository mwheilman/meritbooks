/**
 * Server-only access to vendor TINs (core.vendors.tin_encrypted).
 *
 * Migration 167 (05 R-6) revokes SELECT on that column from anon / authenticated, so a
 * member's RLS client can no longer read it — over PostgREST or from a route. The few
 * server paths that legitimately need it (1099 readiness = "is a TIN on file?",
 * 1099 generation / e-file = the statutory filing, duplicate-vendor detection =
 * equality only) read it here with the service-role client, ALWAYS pinned to the org
 * the caller already resolved. Never return the raw value to a client — mask it
 * (lib/rbac/field-masks.ts) or reduce it to a boolean.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** vendor id → stored TIN (or null). Ids outside `orgId` are silently absent. */
export async function loadVendorTins(
  admin: SupabaseClient,
  orgId: string,
  vendorIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(vendorIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { data, error } = await admin
      .schema('core')
      .from('vendors')
      .select('id, tin_encrypted')
      .eq('org_id', orgId)
      .in('id', slice);
    if (error) throw new Error(`vendor TIN lookup failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; tin_encrypted: string | null }>) {
      out.set(r.id, r.tin_encrypted);
    }
  }
  return out;
}

/** A TIN counts as "on file" when it has any non-blank content. */
export function tinPresent(tin: string | null | undefined): boolean {
  return typeof tin === 'string' && tin.trim().length > 0;
}

/**
 * TINs for a STATUTORY FILING (1099 PDFs / IRS FIRE e-file), which must carry the full
 * TIN. Authorization is the filing route's own compliance gate; every use is written
 * to core.field_reveals (+ action_log) as a logged reveal BEFORE the values are
 * returned — if the log write fails, nothing is returned (no unlogged reveal).
 */
export async function loadVendorTinsForFiling(
  admin: SupabaseClient,
  orgId: string,
  clerkUserId: string,
  vendorIds: readonly string[],
  reason: string,
): Promise<Map<string, string | null>> {
  const tins = await loadVendorTins(admin, orgId, vendorIds);
  const withTin = [...tins.entries()].filter(([, t]) => tinPresent(t)).map(([id]) => id);
  if (withTin.length > 0) {
    const { logFieldReveal } = await import('@/lib/rbac/field-masks');
    const ok = await logFieldReveal(admin, {
      orgId, clerkUserId, fieldClass: 'tin', subjectTable: 'vendors', subjectIds: withTin, reason,
    });
    if (!ok) throw new Error('Could not record the TIN access for this filing; nothing was generated.');
  }
  return tins;
}
