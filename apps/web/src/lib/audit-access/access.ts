/**
 * PBC / audit-access server guards — resolve the caller's compliance capabilities and
 * enforce the requester/fulfiller tiers on the PBC routes.
 *
 * Authorization reuses the EXISTING custom-role-aware resolver: the caller's raw role
 * (system OR the `external_auditor` custom role) is read from core.employees, then
 * `effectivePermission()` merges the system default with the org's overrides. So the
 * External Auditor role's view-only profile is honored here identically to the page/route
 * guards — no parallel model. Fails CLOSED: no role / lookup error → no capability.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { effectivePermission } from '@/lib/rbac/resolve-permissions';
import { TIER_PERMISSION, type PbcTier } from '@/lib/audit-access/pbc';

export interface PbcCapabilities {
  /** The caller's raw role string (may be a custom-role key), or null when none. */
  role: string | null;
  /** compliance.view — read the PBC list, create/accept/waive/reopen a request. */
  canView: boolean;
  /** compliance.manage — assign, fulfill (in-progress/provided), attach a doc, edit, delete. */
  canManage: boolean;
}

/**
 * Resolve the caller's compliance capabilities in an org. Reads the caller's active
 * employee role, then evaluates the two compliance cells through the shared resolver.
 * The `db` client should be able to read the caller's own employee row + the org's
 * custom-role/override rows (the RLS-scoped request client can — org-isolation permits
 * its own org's rows; an admin client works too).
 */
export async function resolvePbcCapabilities(
  db: SupabaseClient,
  orgId: string,
  clerkUserId: string,
): Promise<PbcCapabilities> {
  try {
    const { data: emp, error } = await db
      .schema('core')
      .from('employees')
      .select('role')
      .eq('clerk_user_id', clerkUserId)
      .eq('org_id', orgId)
      .eq('is_active', true)
      .maybeSingle();
    if (error) return { role: null, canView: false, canManage: false };
    const role = (emp?.role ?? null) as string | null;
    if (!role) return { role: null, canView: false, canManage: false };

    const [canView, canManage] = await Promise.all([
      effectivePermission(db, orgId, role, TIER_PERMISSION.requester.feature, TIER_PERMISSION.requester.action),
      effectivePermission(db, orgId, role, TIER_PERMISSION.fulfiller.feature, TIER_PERMISSION.fulfiller.action),
    ]);
    return { role, canView, canManage };
  } catch {
    return { role: null, canView: false, canManage: false };
  }
}

/** True when the caller holds the given tier's capability. */
export function hasTier(caps: PbcCapabilities, tier: PbcTier): boolean {
  return tier === 'fulfiller' ? caps.canManage : caps.canView;
}

/** A standard 403 the PBC routes return when the tier is missing. */
export function forbidden(): NextResponse {
  return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
}
