/**
 * SEPARATION OF DUTIES — the DB layer (migration 165: core.sod_rules,
 * core.sod_rule_settings, core.sod_exceptions, core.organizations SoD settings).
 *
 * All functions take the SERVICE-ROLE client (`createAdminSupabase()`): the SoD tables
 * are member-READ / service-WRITE (05 R-8), and the access tables they reason over live in
 * `core`. Every query is pinned to an explicit, caller-verified org_id. Callers MUST have
 * authorized the actor first (e.g. `core.access.sod_policy:configure` /
 * `core.access.assignments:create`) — this module enforces SoD, not RBAC.
 *
 * Pure decisions live in ./sod.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAccessSnapshot, supabaseAccessSource, type AccessSnapshot, type AssignmentInput } from '@/lib/rbac/effective-access';
import { applyCellOverrides, expandLegacyCells, legacyRoleCells } from '@/lib/rbac/legacy-map';
import { ALL_ROLES, type UserRole } from '@/lib/rbac/permissions';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';
import {
  checkAssignmentSod,
  effectiveEnforcement,
  matchRules,
  toSodRule,
  type AssignmentSodResult,
  type SodConflict,
  type SodException,
  type SodPolicy,
  type SodRule,
  type SodRuleRow,
  type TenantType,
} from '@/lib/rbac/sod';

type Row = Record<string, unknown>;

export interface TenantSodSettings extends SodPolicy {
  soleApproverMode: boolean;
  /** Mig 174: with soleApproverMode on, the largest payment its approver may also release (cents). null = any amount. */
  soleApproverMaxCents: number | null;
  jeSelfPostThresholdCents: number;
}

// ── Loaders ─────────────────────────────────────────────────────────────────────

export async function loadSodRules(admin: SupabaseClient, orgId: string): Promise<SodRule[]> {
  const { data, error } = await admin
    .schema('core')
    .from('sod_rules')
    .select('id, org_id, key, rule_type, name, description, suggested_fix, conflict, enforcement, tenant_type_override, platform_locked, status, sort_order')
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(`Could not load conflict rules: ${error.message}`);
  return ((data ?? []) as SodRuleRow[]).map(toSodRule);
}

export async function loadTenantSodSettings(admin: SupabaseClient, orgId: string): Promise<TenantSodSettings> {
  const readOrg = (cols: string) =>
    admin.schema('core').from('organizations').select(cols).eq('id', orgId).maybeSingle();
  const [orgRes, { data: promos }] = await Promise.all([
    readOrg('tenant_type, sole_approver_mode, sole_approver_max_cents, je_self_post_threshold_cents'),
    admin.schema('core').from('sod_rule_settings').select('rule_id, enforcement').eq('org_id', orgId),
  ]);
  let { data: org, error } = orgRes;
  // 42703 = undefined_column: migration 174 not applied yet → no threshold (165 behavior).
  if (error?.code === '42703') ({ data: org, error } = await readOrg('tenant_type, sole_approver_mode, je_self_post_threshold_cents'));
  if (error) throw new Error(`Could not load SoD settings: ${error.message}`);
  const o = (org ?? {}) as unknown as Row;
  return {
    tenantType: (o.tenant_type === 'firm' ? 'firm' : 'company') as TenantType,
    promotedRuleIds: new Set(((promos ?? []) as Row[]).filter((p) => p.enforcement === 'hard').map((p) => String(p.rule_id))),
    soleApproverMode: o.sole_approver_mode === true,
    soleApproverMaxCents: o.sole_approver_max_cents == null ? null : Number(o.sole_approver_max_cents),
    // Q4 default $25,000 when the column is absent (pre-165 DB): fail toward enforcing.
    jeSelfPostThresholdCents: o.je_self_post_threshold_cents == null ? 2_500_000 : Number(o.je_self_post_threshold_cents),
  };
}

function toException(r: Row): SodException {
  return {
    id: String(r.id),
    ruleId: String(r.rule_id),
    membershipId: String(r.membership_id),
    locationId: (r.location_id as string | null) ?? null,
    justification: String(r.justification ?? ''),
    compensatingControl: (r.compensating_control as string | null) ?? null,
    approvedBy: String(r.approved_by),
    expiresAt: String(r.expires_at),
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

export async function loadSodExceptions(admin: SupabaseClient, orgId: string, membershipId?: string): Promise<SodException[]> {
  let q = admin.schema('core').from('sod_exceptions').select('*').eq('org_id', orgId).is('revoked_at', null);
  if (membershipId) q = q.eq('membership_id', membershipId);
  const { data, error } = await q.order('expires_at', { ascending: true });
  if (error) throw new Error(`Could not load allowed conflicts: ${error.message}`);
  return ((data ?? []) as Row[]).map(toException);
}

async function loadOrgLocationIds(admin: SupabaseClient, orgId: string): Promise<string[]> {
  const { data } = await admin.schema('core').from('locations').select('id').eq('org_id', orgId);
  return ((data ?? []) as Row[]).map((r) => String(r.id));
}

// ── Assignment-time check (new access model) ────────────────────────────────────

export interface GuardAssignmentInput {
  orgId: string;
  membershipId: string;
  /** Assignment rows being created / replaced, already shaped for the resolver. */
  proposed: AssignmentInput[];
  removedIds?: string[];
  /** Grantor's written reason for soft conflicts (05 §4.3). */
  justification?: string | null;
  compensatingControl?: string | null;
  /** core.users.id of the grantor (recorded as granted_by + approved_by of any new allowed conflict). */
  grantorUserId: string;
  /** Allowed-conflict expiry (default one year; DB caps at one year). */
  exceptionExpiresAt?: string;
}

export type GuardAssignmentResult =
  | { ok: true; result: AssignmentSodResult; exceptionIds: string[] }
  | { ok: false; result: AssignmentSodResult; status: 409 | 422; error: string };

/**
 * THE assignment-time SoD gate (05 §4.3). Call it BEFORE writing a new / changed
 * core.access_assignments row (or publishing a role / permission set — pass every
 * holder's assignment with the new grants). On ok, put `exceptionIds` into the
 * assignment's `sod_exception_ids`.
 *   - new hard conflict          → { ok:false, status 409 }
 *   - new soft conflict, no reason → { ok:false, status 422 } (UI asks for a justification)
 *   - new soft conflict + reason → records allowed conflicts, { ok:true, exceptionIds }
 */
export async function guardAssignmentWrite(admin: SupabaseClient, input: GuardAssignmentInput): Promise<GuardAssignmentResult> {
  const snapshot = await loadAccessSnapshot(supabaseAccessSource(admin), input.membershipId);
  if (!snapshot || snapshot.membership.orgId !== input.orgId) {
    throw new Error('Member not found in this organization');
  }
  const [rules, settings, exceptions, orgLocationIds] = await Promise.all([
    loadSodRules(admin, input.orgId),
    loadTenantSodSettings(admin, input.orgId),
    loadSodExceptions(admin, input.orgId, input.membershipId),
    loadOrgLocationIds(admin, input.orgId),
  ]);
  const result = checkAssignmentSod({
    current: snapshot,
    proposed: input.proposed,
    removedIds: input.removedIds,
    justification: input.justification,
    rules,
    policy: settings,
    exceptions,
    orgLocationIds,
  });
  if (result.blocked.length > 0) {
    return { ok: false, result, status: 409, error: result.messages[0] ?? 'This access would create a blocked conflict.' };
  }
  if (result.needsJustification.length > 0) {
    return { ok: false, result, status: 422, error: 'This access creates a conflict. Enter a reason to allow it.' };
  }
  const exceptionIds = [
    ...new Set(result.covered.map((c) => c.exceptionId).filter((x): x is string => !!x)),
  ];
  if (result.toRecord.length > 0) {
    const ids = await recordSodExceptions(admin, {
      orgId: input.orgId,
      membershipId: input.membershipId,
      conflicts: result.toRecord,
      justification: (input.justification ?? '').trim(),
      compensatingControl: input.compensatingControl ?? null,
      grantedBy: input.grantorUserId,
      approvedBy: input.grantorUserId,
      expiresAt: input.exceptionExpiresAt,
    });
    exceptionIds.push(...ids);
  }
  return { ok: true, result, exceptionIds };
}

export async function recordSodExceptions(
  admin: SupabaseClient,
  input: {
    orgId: string;
    membershipId: string;
    conflicts: Pick<SodConflict, 'ruleId' | 'ruleKey' | 'locationId'>[];
    justification: string;
    compensatingControl: string | null;
    grantedBy: string | null;
    approvedBy: string;
    expiresAt?: string;
  },
): Promise<string[]> {
  if (input.conflicts.length === 0) return [];
  const seen = new Set<string>();
  const rows = input.conflicts
    .filter((c) => {
      const k = `${c.ruleId}@${c.locationId ?? '*'}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => ({
      org_id: input.orgId,
      rule_id: c.ruleId,
      rule_key: c.ruleKey,
      membership_id: input.membershipId,
      location_id: c.locationId,
      justification: input.justification,
      compensating_control: input.compensatingControl,
      granted_by: input.grantedBy,
      approved_by: input.approvedBy,
      ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
    }));
  const { data, error } = await admin.schema('core').from('sod_exceptions').insert(rows).select('id');
  if (error) throw new Error(`Could not record the allowed conflict: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => String(r.id));
}

export async function revokeSodException(
  admin: SupabaseClient,
  orgId: string,
  exceptionId: string,
  revokedBy: string,
  reason: string | null,
): Promise<void> {
  const { data, error } = await admin
    .schema('core')
    .from('sod_exceptions')
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy, revoke_reason: reason })
    .eq('org_id', orgId)
    .eq('id', exceptionId)
    .is('revoked_at', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('Allowed conflict not found or already removed');
}

/** Every current conflict of one member (DB function — the SQL twin of detectConflicts). */
export async function conflictsForMembership(admin: SupabaseClient, membershipId: string): Promise<SodConflict[]> {
  const { data, error } = await admin.schema('core').rpc('sod_conflicts_for_membership', { p_membership_id: membershipId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map((r) => ({
    ruleId: String(r.rule_id),
    ruleKey: String(r.rule_key),
    name: String(r.rule_name),
    description: String(r.description),
    suggestedFix: (r.suggested_fix as string | null) ?? null,
    enforcement: r.enforcement === 'hard' ? 'hard' : r.enforcement === 'txn_only' ? 'txn_only' : 'soft',
    locationId: (r.location_id as string | null) ?? null,
    matched: (r.matched as string[]) ?? [],
    exceptionId: (r.exception_id as string | null) ?? null,
    exceptionExpiresAt: (r.exception_expires_at as string | null) ?? null,
  }));
}

// ── Legacy role path (compat until the R-11 flip) ───────────────────────────────

async function legacyCapabilitySet(
  admin: SupabaseClient,
  orgId: string,
  roleKey: string,
  extraOverride?: { cell: string; allowed: boolean },
): Promise<Set<string> | null> {
  let base: UserRole | null = normalizeMembershipRole(roleKey);
  if (!base) {
    const { data: custom } = await admin.schema('core').from('custom_roles')
      .select('base_role').eq('org_id', orgId).eq('key', roleKey).maybeSingle();
    base = normalizeMembershipRole((custom as Row | null)?.base_role as string | undefined);
  }
  if (!base || !(ALL_ROLES as readonly string[]).includes(base)) return null;
  const keys = [...new Set([base, roleKey])];
  const { data: ov } = await admin.schema('core').from('role_permission_overrides')
    .select('role_key, feature, action, allowed').eq('org_id', orgId).in('role_key', keys);
  const overrides: Record<string, boolean> = {};
  // System-key overrides first, then the custom key's own overrides win.
  for (const k of keys) {
    for (const r of ((ov ?? []) as Row[]).filter((x) => x.role_key === k)) {
      overrides[`${r.feature}::${r.action}`] = r.allowed === true;
    }
  }
  if (extraOverride) overrides[extraOverride.cell] = extraOverride.allowed;
  const grants = expandLegacyCells(applyCellOverrides(legacyRoleCells(base), overrides));
  const set = new Set<string>();
  for (const [cap, actions] of grants) for (const a of actions) set.add(`${cap}:${a}`);
  return set;
}

export interface LegacyRoleSodResult {
  /** New hard conflicts the change would create — the route must refuse. */
  blocked: Array<{ ruleKey: string; description: string; suggestedFix: string | null }>;
  /** New soft conflicts — reported (warn) and logged; the legacy route has no justification field. */
  warnings: Array<{ ruleKey: string; description: string; suggestedFix: string | null }>;
  /**
   * The conflict catalog could not be read, so hard rules could not be checked: the
   * change is BLOCKED (fail closed, wave 2G) — the route should answer 503 / retry.
   */
  unavailable?: boolean;
}

/** Fail-closed result when the rule catalog / settings can't be read (wave 2G). */
const SOD_UNAVAILABLE: LegacyRoleSodResult = {
  blocked: [{
    ruleKey: 'SOD_CATALOG_UNAVAILABLE',
    description: 'The separation-of-duties rules could not be checked right now.',
    suggestedFix: 'Try again in a moment.',
  }],
  warnings: [],
  unavailable: true,
};

/**
 * Assignment-time SoD for the LEGACY role path (PATCH /api/team/members/[id]). Legacy
 * roles are tenant-wide, so the check runs on one context. Only conflicts the NEW role
 * creates (absent from the old role) are reported. Fails CLOSED (wave 2G) when the
 * catalog can't be read: hard rules are always-on, so a change that cannot be checked
 * against them is refused (`unavailable: true`) rather than waved through.
 */
export async function legacyRoleChangeSod(
  admin: SupabaseClient,
  orgId: string,
  fromRole: string | null,
  toRole: string,
): Promise<LegacyRoleSodResult> {
  try {
    const [rules, settings, after, before] = await Promise.all([
      loadSodRules(admin, orgId),
      loadTenantSodSettings(admin, orgId),
      legacyCapabilitySet(admin, orgId, toRole),
      fromRole ? legacyCapabilitySet(admin, orgId, fromRole) : Promise.resolve(new Set<string>()),
    ]);
    if (!after) return { blocked: [], warnings: [] };
    return diffLegacy(rules, settings, before ?? new Set(), after);
  } catch {
    return SOD_UNAVAILABLE;
  }
}

function diffLegacy(
  rules: SodRule[],
  settings: SodPolicy,
  before: Set<string>,
  after: Set<string>,
): LegacyRoleSodResult {
  const had = new Set(matchRules(rules, before).map((m) => m.rule.id));
  const blocked: LegacyRoleSodResult['blocked'] = [];
  const warnings: LegacyRoleSodResult['warnings'] = [];
  for (const { rule } of matchRules(rules, after)) {
    if (had.has(rule.id)) continue;
    const enf = effectiveEnforcement(rule, settings);
    const item = { ruleKey: rule.key, description: rule.description, suggestedFix: rule.suggestedFix };
    if (enf === 'hard') blocked.push(item);
    else if (enf === 'soft') warnings.push(item);
  }
  return { blocked, warnings };
}

/**
 * Same check for a mig-130 cell override (PUT /api/rbac/overrides): granting a cell to a
 * role changes every holder's set at once. Only a GRANT can create a conflict.
 */
export async function legacyOverrideSod(
  admin: SupabaseClient,
  orgId: string,
  roleKey: string,
  cell: string,
  allowed: boolean,
): Promise<LegacyRoleSodResult> {
  if (!allowed) return { blocked: [], warnings: [] };
  try {
    const [rules, settings, before, after] = await Promise.all([
      loadSodRules(admin, orgId),
      loadTenantSodSettings(admin, orgId),
      legacyCapabilitySet(admin, orgId, roleKey),
      legacyCapabilitySet(admin, orgId, roleKey, { cell, allowed }),
    ]);
    if (!before || !after) return { blocked: [], warnings: [] };
    return diffLegacy(rules, settings, before, after);
  } catch {
    return SOD_UNAVAILABLE;
  }
}

/** Snapshot helper for callers that already hold a membership id. */
export async function loadSnapshot(admin: SupabaseClient, membershipId: string): Promise<AccessSnapshot | null> {
  return loadAccessSnapshot(supabaseAccessSource(admin), membershipId);
}
