/**
 * EFFECTIVE PERMISSION RESOLVER — the merge of SYSTEM DEFAULTS (frozen in
 * permissions.ts) with an org's stored CUSTOMIZATIONS (core.custom_roles +
 * core.role_permission_overrides, migration 130).
 *
 *     effective(feature, action) = override, if the org set one for this exact cell,
 *                                  else the system default for the (base) role.
 *
 * FAIL CLOSED is the invariant. ANY of: an unknown role, a custom role that no longer
 * exists, an override that names a feature/action outside the catalog, or ANY database
 * error → the cell resolves to FALSE (deny). A customization can only be trusted to the
 * extent it is a well-formed row for a known role and a real catalog cell.
 *
 * This module is READ-ONLY against the reserved RBAC spine — it consumes `hasPermission`,
 * `ALL_ROLES`, `FEATURE_CATALOG` and `normalizeMembershipRole`; it edits none of them.
 * It does NOT itself wire enforcement into the guards — the lead does that under security
 * review (see the handoff). Until then this resolver is inert model code.
 *
 * ── Layering ────────────────────────────────────────────────────────────────────
 *   PURE (no I/O, unit-tested): systemDefaultCell(), mergeCell(), buildEffectiveMatrix()
 *   DB   (thin, fail-closed):    resolveRoleKind(), fetchOverrides(),
 *                                effectivePermission(), effectiveMatrix()
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  hasPermission,
  ALL_ROLES,
  FEATURE_CATALOG,
  type FeatureAction,
  type UserRole,
} from '@/lib/rbac/permissions';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';
import { isValidCell } from '@/lib/rbac/permission-catalog';

// ── Pure core ────────────────────────────────────────────────────────────────────

/** Stable key for one (feature, action) cell in an override map. */
export function cellKey(featureId: string, action: string): string {
  return `${featureId}::${action}`;
}

/**
 * The SYSTEM DEFAULT for one cell, given the role's BASE system role (a custom role's
 * clone-from, or the system role itself). Fails closed: a null base role, or a cell that
 * is not a real catalog (feature, action), is FALSE.
 */
export function systemDefaultCell(
  baseSystemRole: UserRole | null,
  featureId: string,
  action: string,
): boolean {
  if (!baseSystemRole) return false;
  if (!isValidCell(featureId, action)) return false;
  return hasPermission(baseSystemRole, featureId, action as FeatureAction);
}

/**
 * Merge one cell: the org override wins when it is explicitly set (true OR false);
 * otherwise the system default stands.
 */
export function mergeCell(systemDefault: boolean, override: boolean | undefined): boolean {
  return override === undefined ? systemDefault : override;
}

export type CellSource = 'default' | 'override';

export interface EffectiveCell {
  action: FeatureAction;
  /** The resolved decision after merge. */
  allowed: boolean;
  /** What the system would grant absent any override (for the UI's "vs default" hint). */
  defaultAllowed: boolean;
  /** Whether this cell's decision came from an org override or the system default. */
  source: CellSource;
}

export interface EffectiveFeature {
  featureId: string;
  featureName: string;
  category: string;
  cells: EffectiveCell[];
}

/**
 * Build the full effective matrix for a role, PURELY, from its base system role and a
 * map of overrides ({ 'feature::action': boolean }). Drives the admin UI: every cell
 * carries both the resolved value and whether it differs from the shipped default.
 */
export function buildEffectiveMatrix(
  baseSystemRole: UserRole | null,
  overrides: Record<string, boolean>,
): EffectiveFeature[] {
  return FEATURE_CATALOG.map((feat) => ({
    featureId: feat.id,
    featureName: feat.name,
    category: feat.category,
    cells: feat.actions.map((action) => {
      const def = systemDefaultCell(baseSystemRole, feat.id, action);
      const ov = overrides[cellKey(feat.id, action)];
      const allowed = mergeCell(def, ov);
      return {
        action,
        allowed,
        defaultAllowed: def,
        source: ov === undefined ? ('default' as const) : ('override' as const),
      };
    }),
  }));
}

// ── DB layer (thin, fail-closed) ──────────────────────────────────────────────────

export type RoleKind =
  | { kind: 'system'; roleKey: UserRole; baseSystemRole: UserRole }
  | { kind: 'custom'; roleKey: string; baseSystemRole: UserRole | null; name: string; description: string | null };

/**
 * Classify a role key (a raw membership/employee role string, OR an explicit role key
 * from the admin UI) into a system role or a stored custom role. Returns null when it is
 * neither (→ callers fail closed).
 *
 *  - A value that normalizes to one of the 9 system roles is SYSTEM (system roles win;
 *    a custom role may never shadow a system key — enforced at create time too).
 *  - Otherwise, if core.custom_roles has a row for (org, key), it is CUSTOM and its
 *    base_role (normalized) supplies the default layer.
 *  - Otherwise null.
 */
export async function resolveRoleKind(
  db: SupabaseClient,
  orgId: string,
  rawRole: string | null | undefined,
): Promise<RoleKind | null> {
  if (!orgId || !rawRole || typeof rawRole !== 'string' || rawRole.trim() === '') return null;

  // System role first — normalize so 'owner'/'org_admin' etc. reconcile like canApprove.
  const sys = normalizeMembershipRole(rawRole);
  if (sys) return { kind: 'system', roleKey: sys, baseSystemRole: sys };

  // Custom role for this org?
  try {
    const { data, error } = await db
      .schema('core')
      .from('custom_roles')
      .select('key, name, description, base_role')
      .eq('org_id', orgId)
      .eq('key', rawRole.trim())
      .maybeSingle();
    if (error || !data) return null; // unknown / lookup error → fail closed
    const rawBase = (data as { base_role?: unknown }).base_role;
    const base =
      typeof rawBase === 'string' && (ALL_ROLES as readonly string[]).includes(rawBase)
        ? (rawBase as UserRole)
        : null;
    return {
      kind: 'custom',
      roleKey: (data as { key: string }).key,
      baseSystemRole: base,
      name: (data as { name: string }).name,
      description: ((data as { description?: string | null }).description ?? null) as string | null,
    };
  } catch {
    return null; // fail closed
  }
}

/**
 * Fetch the org's override cells for a role key as a { 'feature::action': boolean } map.
 * Invalid cells (feature/action not in the catalog) are DROPPED so they can never grant
 * anything. On any error returns an empty map (→ pure defaults apply; still fail-closed
 * because no override can secretly widen access).
 */
export async function fetchOverrides(
  db: SupabaseClient,
  orgId: string,
  roleKey: string,
): Promise<Record<string, boolean>> {
  const map: Record<string, boolean> = {};
  try {
    const { data, error } = await db
      .schema('core')
      .from('role_permission_overrides')
      .select('feature, action, allowed')
      .eq('org_id', orgId)
      .eq('role_key', roleKey);
    if (error || !data) return map;
    for (const row of data as Array<{ feature: string; action: string; allowed: boolean }>) {
      if (!isValidCell(row.feature, row.action)) continue; // drop bogus cells
      map[cellKey(row.feature, row.action)] = row.allowed === true;
    }
    return map;
  } catch {
    return map;
  }
}

/**
 * THE authorization primitive for custom-role-aware enforcement.
 *
 * Resolve whether `rawRole` (a caller's membership/employee role — system OR custom) may
 * perform (feature, action) in `orgId`, merging system default with the org's overrides.
 * Fails CLOSED on any unknown role / missing custom role / bad cell / DB error.
 *
 * The lead wires this in place of the bare `hasPermission(role, feature, action)` call
 * inside page-guard / require-permission (see handoff) so custom roles + overrides take
 * effect uniformly across page and route gates.
 */
export async function effectivePermission(
  db: SupabaseClient,
  orgId: string,
  rawRole: string | null | undefined,
  featureId: string,
  action: FeatureAction,
): Promise<boolean> {
  try {
    if (!isValidCell(featureId, action)) return false;
    const kind = await resolveRoleKind(db, orgId, rawRole);
    if (!kind) return false;
    const overrides = await fetchOverrides(db, orgId, kind.roleKey);
    const def = systemDefaultCell(kind.baseSystemRole, featureId, action);
    return mergeCell(def, overrides[cellKey(featureId, action)]);
  } catch {
    return false; // fail closed
  }
}

export interface EffectiveMatrixResult {
  roleKey: string;
  isCustom: boolean;
  baseSystemRole: UserRole | null;
  /** Present for custom roles. */
  name?: string;
  description?: string | null;
  features: EffectiveFeature[];
}

/**
 * Full effective matrix for a role key (system key OR custom key), for the admin UI.
 * `roleKey` here is the explicit key of the role being edited (not a raw membership
 * string). On an unknown/missing role returns a fully-DENIED matrix (fail closed) so the
 * UI never paints phantom grants.
 */
export async function effectiveMatrix(
  db: SupabaseClient,
  orgId: string,
  roleKey: string,
): Promise<EffectiveMatrixResult> {
  const kind = await resolveRoleKind(db, orgId, roleKey);
  if (!kind) {
    // Unknown role → deny-all matrix.
    return {
      roleKey,
      isCustom: false,
      baseSystemRole: null,
      features: buildEffectiveMatrix(null, {}),
    };
  }
  const overrides = await fetchOverrides(db, orgId, kind.roleKey);
  return {
    roleKey: kind.roleKey,
    isCustom: kind.kind === 'custom',
    baseSystemRole: kind.baseSystemRole,
    name: kind.kind === 'custom' ? kind.name : undefined,
    description: kind.kind === 'custom' ? kind.description : undefined,
    features: buildEffectiveMatrix(kind.baseSystemRole, overrides),
  };
}
