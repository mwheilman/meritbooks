/**
 * EXTERNAL AUDITOR — a shipped, READ-ONLY custom role for outside CPAs / accountants.
 *
 * This is NOT a new system role (permissions.ts, the reserved RBAC spine, is untouched).
 * It is a definition expressed entirely through the EXISTING customizable-RBAC system
 * (migration 130): a `core.custom_roles` row keyed `external_auditor`, cloned from a base
 * whose internal-feature defaults are all OFF, PLUS a set of explicit view-only
 * `core.role_permission_overrides`. Enforcement then flows through the SAME
 * `effectivePermission()` the page-guard and route-guard already call — so an auditor is
 * gated identically to every other role, with no bespoke code path.
 *
 * WHY `business_user` IS THE BASE: of the 9 system roles it is the only one whose defaults
 * for every INTERNAL feature (dashboard, reports, bills, journal_entries, …) are OFF (it
 * only turns on the `biz_*` external screens). So cloning from it means NOTHING internal is
 * granted by default — the auditor's access is EXACTLY the explicit view overrides below and
 * nothing can leak in through an inherited create/edit/approve default. Fail-closed by
 * construction: any feature/action not listed here resolves to the (OFF) base default.
 *
 * The grant is strictly READ: `view` on the financial surfaces an auditor examines, plus
 * `export` on reports (downloading a report is a read, not a mutation). There is NO
 * create / edit / approve / post / run / reconcile / resolve / manage / generate / assign /
 * delete / request anywhere — proven by a unit test over this exact override set.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeatureAction, UserRole } from '@/lib/rbac/permissions';
import { buildEffectiveMatrix, cellKey, type EffectiveFeature } from '@/lib/rbac/resolve-permissions';
import { isValidCell } from '@/lib/rbac/permission-catalog';

/** Stable role key stored as core.custom_roles.key and on the caller's employee/membership row. */
export const EXTERNAL_AUDITOR_ROLE_KEY = 'external_auditor' as const;

export const EXTERNAL_AUDITOR_ROLE_NAME = 'External Auditor' as const;

export const EXTERNAL_AUDITOR_ROLE_DESCRIPTION: string =
  'Read-only access for an outside CPA / auditor. Can view the books — dashboard, financial ' +
  'reports, journal entries, bank feed, bills, invoices, vendors, customers, jobs, ' +
  'reconciliation, close, payroll, and the audit trail — plus raise and accept PBC requests. ' +
  'Cannot create, edit, approve, post, reconcile, move money, or change any setting.';

/**
 * The base system role we clone from. `business_user`'s internal-feature defaults are all
 * OFF, so the effective grant is exactly the explicit overrides below (nothing inherited).
 */
export const EXTERNAL_AUDITOR_BASE_ROLE: UserRole = 'business_user';

/**
 * The financial surfaces the auditor may VIEW. Every one grants only `view` (read). Reports
 * additionally grant `export` (download a P&L / balance sheet — a read, never a write).
 */
const VIEW_FEATURES: readonly string[] = [
  'dashboard',
  'bank_feed',
  'credit_cards',
  'receipts',
  'bills',
  'journal_entries',
  'flagged',
  'vendors',
  'customers',
  'invoices',
  'jobs',
  'reports',
  'chart_of_accounts',
  'reconciliation',
  'close_mgmt',
  'payroll',
  'intercompany',
  'cash_position',
  'forecast',
  'compliance',
  'fixed_assets',
  'recurring',
  'audit_trail',
];

/** One override cell the provisioner writes / the resolver reads. */
export interface AuditorOverrideCell {
  feature: string;
  action: FeatureAction;
  allowed: boolean;
}

/**
 * The canonical, single-source-of-truth override set for the External Auditor role. Only
 * read verbs appear, and every `allowed` is `true` (grant a read) — there is intentionally
 * no write verb anywhere in this list. This same array is what `provisionExternalAuditorRole`
 * writes to `core.role_permission_overrides`, so the DB state and the unit-tested profile can
 * never drift.
 */
export function externalAuditorOverrideCells(): AuditorOverrideCell[] {
  const cells: AuditorOverrideCell[] = [];
  for (const feature of VIEW_FEATURES) {
    // Every feature above is granted `view`; guard against a catalog rename with isValidCell.
    if (isValidCell(feature, 'view')) cells.push({ feature, action: 'view', allowed: true });
  }
  // Reports may also be exported (download), which is a read, not a mutation.
  if (isValidCell('reports', 'export')) cells.push({ feature: 'reports', action: 'export', allowed: true });
  return cells;
}

/** The override set as the `{ 'feature::action': boolean }` map buildEffectiveMatrix expects. */
export function buildExternalAuditorOverrideMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const c of externalAuditorOverrideCells()) {
    map[cellKey(c.feature, c.action)] = c.allowed;
  }
  return map;
}

/**
 * The auditor's full EFFECTIVE permission matrix, computed PURELY (no I/O) — base-role
 * defaults merged with the override set. Used by the unit test to PROVE the profile is
 * view-only, and available to any UI that wants to show what the role grants.
 */
export function buildExternalAuditorMatrix(): EffectiveFeature[] {
  return buildEffectiveMatrix(EXTERNAL_AUDITOR_BASE_ROLE, buildExternalAuditorOverrideMap());
}

/** Verbs that mutate state / move money. The auditor role must grant NONE of these. */
export const WRITE_ACTIONS: readonly FeatureAction[] = [
  'create',
  'edit',
  'approve',
  'delete',
  'request',
  'post',
  'resolve',
  'reconcile',
  'manage',
  'generate',
  'run',
  'assign',
];

/** True when the given role key is (case-insensitively) the External Auditor role. */
export function isExternalAuditorRole(roleKey: string | null | undefined): boolean {
  return typeof roleKey === 'string' && roleKey.trim().toLowerCase() === EXTERNAL_AUDITOR_ROLE_KEY;
}

/**
 * Idempotently PROVISION the External Auditor role for an org: upsert the custom-role row
 * and its view-only override cells. Safe to call repeatedly (unique indexes back both
 * upserts). Runs on the caller's RLS-scoped client — the org-isolation policy requires
 * org_id = get_org_id(), so `orgId` must be the caller's own org.
 *
 * Returns the role key on success; throws on a hard DB error so the caller can surface it.
 */
export async function provisionExternalAuditorRole(
  db: SupabaseClient,
  orgId: string,
  actorClerkUserId: string | null,
): Promise<string> {
  // 1. The custom role itself (org-unique by key).
  const { error: roleErr } = await db
    .schema('core')
    .from('custom_roles')
    .upsert(
      {
        org_id: orgId,
        key: EXTERNAL_AUDITOR_ROLE_KEY,
        name: EXTERNAL_AUDITOR_ROLE_NAME,
        description: EXTERNAL_AUDITOR_ROLE_DESCRIPTION,
        base_role: EXTERNAL_AUDITOR_BASE_ROLE,
        created_by: actorClerkUserId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,key' },
    );
  if (roleErr) throw new Error(`Failed to provision external-auditor role: ${roleErr.message}`);

  // 2. Its view-only override cells (one per granted read).
  const rows = externalAuditorOverrideCells().map((c) => ({
    org_id: orgId,
    role_key: EXTERNAL_AUDITOR_ROLE_KEY,
    feature: c.feature,
    action: c.action,
    allowed: c.allowed,
    set_by: actorClerkUserId,
    updated_at: new Date().toISOString(),
  }));
  const { error: ovErr } = await db
    .schema('core')
    .from('role_permission_overrides')
    .upsert(rows, { onConflict: 'org_id,role_key,feature,action' });
  if (ovErr) throw new Error(`Failed to provision external-auditor permissions: ${ovErr.message}`);

  return EXTERNAL_AUDITOR_ROLE_KEY;
}
