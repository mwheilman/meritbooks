/**
 * Where customer money settles is money movement (security review, Wave 1 MEDIUM-4).
 *
 * Opening Stripe onboarding / the Stripe Express dashboard lets the person in front of it set
 * or change the payout bank account, and switching per-company ↔ single-account mode
 * re-routes every company's collections into one account. Both used to need only
 * settings_system:edit. They now ALSO need the money-movement release authority (the same
 * gate that releases AP payments — requireMoneyMovement, most-granular key first, never
 * looser than the legacy gate), and every change notifies the tenant's owner(s) in-app and
 * lands in the action log, so a quiet re-route of settlement cannot go unnoticed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PermissionResult } from '@/lib/rbac/require-permission';
import { requireMoneyMovement, PAYMENTS_EXECUTE, AP_DISBURSEMENT_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { notifyMembers, tenantAdminMemberships } from '@/lib/notify/in-app';
import { logHumanAction } from '@/lib/trust/action-log';

/** Money-movement release authority (falls back to settings_system:edit only while neither money key is catalogued). */
export function requireSettlementAuthority(userId: string): Promise<PermissionResult> {
  return requireMoneyMovement(userId, PAYMENTS_EXECUTE, { feature: 'settings_system', action: 'edit' }, AP_DISBURSEMENT_RELEASE_FEATURE);
}

/** Active owner memberships of the tenant; the admin set when no owner row exists. */
export async function tenantOwnerMemberships(db: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await db
    .schema('core')
    .from('memberships')
    .select('id, role, status')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .eq('role', 'owner');
  const owners = error ? [] : ((data ?? []) as Array<{ id: string }>).map((m) => m.id);
  return owners.length > 0 ? owners : tenantAdminMemberships(db, orgId);
}

export interface SettlementChange {
  orgId: string;
  actorUserId: string;
  /** action-log verb, e.g. 'payments.stripe.onboarding_opened'. */
  action: string;
  title: string;
  body: string;
  locationId?: string | null;
  subjectTable: string;
  subjectId: string;
  /** Collapses repeats (e.g. per actor + company + day). */
  dedupeKey?: string | null;
}

/** Notify the owner(s) and write the action log. Never throws — the change already happened. */
export async function recordSettlementChange(admin: SupabaseClient, c: SettlementChange): Promise<void> {
  try {
    const owners = await tenantOwnerMemberships(admin, c.orgId);
    await notifyMembers(admin, owners, {
      orgId: c.orgId,
      kind: 'payments.settlement_change',
      severity: 'attention',
      title: c.title,
      body: c.body,
      deepLink: '/settings/payments',
      locationId: c.locationId ?? null,
      dedupeKey: c.dedupeKey ?? null,
    });
  } catch (e) {
    console.warn('[settlement] owner notification failed (non-fatal)', e);
  }
  await logHumanAction(admin, c.actorUserId, c.orgId, {
    action: c.action,
    subjectTable: c.subjectTable,
    subjectId: c.subjectId,
    summary: c.body.slice(0, 500),
    locationId: c.locationId ?? null,
  });
}
