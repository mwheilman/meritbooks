/**
 * EFFECTIVE ACCESS — resolves what a membership may do, per client, from the wave-1
 * access tables (05-RBAC-SPEC §1.4 stacking rule, §1.8 resolution steps 1–6).
 *
 *   PURE   resolveEffectiveAccess(snapshot, context) → EffectiveAccess
 *          can(effective, capability, action, resource?) → AccessDecision
 *          compareDecision(...)                        → LegacyComparison  (dual-run)
 *   DB     loadAccessSnapshot(source, membershipId)     → AccessSnapshot
 *          supabaseAccessSource(db)                     → AccessDataSource
 *          compareWithLegacy(db, …)                     → LegacyComparison
 *
 * NOT WIRED INTO ENFORCEMENT. Wave 1 ships the model and a dual-run comparator only;
 * requirePermission / page-guard / canApprove keep deciding until the wave-2 flip (R-11),
 * which runs both side by side and logs every disagreement (toDualRunLogEntry).
 *
 * Fail-closed: an inactive membership, an expired / non-active assignment, a missing
 * envelope for a client-owned role, or an unknown capability resolves to DENY.
 *
 * Deny is the default; roles and permission sets only ALLOW. The only subtractive
 * operations are per-assignment narrowing (mutes, read-only) and ceilings (audience,
 * platform-only, client envelope).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ACTIONS, CAPABILITY_BY_KEY, type Action } from '@/lib/rbac/capabilities';
import type { Audience, GrantConstraints } from '@/lib/rbac/access-templates';
import type { FeatureAction } from '@/lib/rbac/permissions';
import {
  LEGACY_PRIMARY,
  applyCellOverrides,
  expandLegacyCells,
  legacyCell,
  legacyRoleCells,
  legacyScopeKind,
  type LegacyCell,
  type LegacyScopeKind,
} from '@/lib/rbac/legacy-map';

// ── Types ─────────────────────────────────────────────────────────────────────────

export type ScopeType = 'all_clients' | 'client' | 'client_set' | 'consolidation_group' | 'tenant';
export type AssignmentStatus = 'pending_approval' | 'active' | 'suspended' | 'expired' | 'revoked';
export type MembershipStatus = 'active' | 'invited' | 'suspended';
export type OwnerLevel = 'platform' | 'tenant' | 'client';

export interface ResolvedGrant {
  capability: string;
  actions: Action[];
  constraints: GrantConstraints;
}

export interface GrantSourceRef {
  id: string;
  key: string;
  name: string;
  ownerLevel: OwnerLevel;
  /** For client-owned roles / sets: the client that owns it. */
  locationId: string | null;
  audience: Audience;
  /** The published (Current) version the grants come from; null = nothing published. */
  version: number | null;
}

export interface AssignmentInput {
  id: string;
  grantType: 'role' | 'permission_set';
  source: GrantSourceRef;
  grants: ResolvedGrant[];
  scopeType: ScopeType;
  locationId: string | null;
  clientSetId: string | null;
  /** Materialized members of the client set (scope_type = client_set). */
  clientSetLocationIds: string[];
  groupId: string | null;
  readOnly: boolean;
  muted: Record<string, Action[]>;
  constraintOverrides: GrantConstraints;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: AssignmentStatus;
}

export interface AccessSnapshot {
  membership: { id: string; orgId: string; status: MembershipStatus; audience: Audience; accessEpoch: number };
  assignments: AssignmentInput[];
  /** Current envelope grants per client (only needed for client-owned roles / sets). */
  envelopes: Record<string, ResolvedGrant[]>;
}

export type AccessContext =
  | { kind: 'client'; locationId: string }
  | { kind: 'tenant' }
  | { kind: 'group'; groupId: string; memberLocationIds?: string[] }
  | { kind: 'any' };

export interface GrantTrace {
  assignmentId: string;
  grantType: 'role' | 'permission_set';
  sourceKey: string;
  sourceName: string;
  version: number | null;
  scopeType: ScopeType;
  constraints: GrantConstraints;
  /** True for IA Q4 implicit group view from an all-clients assignment. */
  implicit?: boolean;
}

export interface EffectiveAccess {
  membershipId: string;
  context: AccessContext;
  /** Set when the whole membership is denied before any grant is considered. */
  denied: 'membership_inactive' | null;
  capabilities: Map<string, Map<Action, GrantTrace[]>>;
}

export type DecisionReason = 'ok' | 'no_grant' | 'membership_inactive' | 'unknown_capability' | 'constraint:limit';

export interface AccessDecision {
  allow: boolean;
  reason: DecisionReason;
  trace: GrantTrace[];
  /** View granted only because another action on the capability is held (05 §2.1). */
  implied: boolean;
  /** Highest per-item limit among passing grants (null = unlimited / no limit applies). */
  limitCents: number | null;
  /** Constraint kinds present on the matching grants that wave 1 does not evaluate yet. */
  unevaluated: string[];
}

// ── Pure resolver ─────────────────────────────────────────────────────────────────

const LIMITED_BY_DEFAULT: readonly Action[] = ['approve', 'post', 'release'];
const OWNERSHIP_ORDER = { own: 0, team: 1, all: 2 } as const;

function isActive(a: AssignmentInput, now: Date): boolean {
  if (a.status !== 'active') return false;
  if (a.effectiveFrom && new Date(a.effectiveFrom).getTime() > now.getTime()) return false;
  if (a.effectiveTo && new Date(a.effectiveTo).getTime() <= now.getTime()) return false;
  return true;
}

function covers(a: AssignmentInput, ctx: AccessContext): boolean {
  switch (ctx.kind) {
    case 'any':
      return true;
    case 'tenant':
      return a.scopeType === 'all_clients' || a.scopeType === 'tenant';
    case 'client':
      if (a.scopeType === 'all_clients') return true;
      if (a.scopeType === 'client') return a.locationId === ctx.locationId;
      if (a.scopeType === 'client_set') return a.clientSetLocationIds.includes(ctx.locationId);
      return false;
    case 'group':
      return a.scopeType === 'consolidation_group' && a.groupId === ctx.groupId;
  }
}

/** Tighten-only merge of an assignment's constraint overrides onto a grant's constraints. */
export function tightenConstraints(base: GrantConstraints, over: GrantConstraints): GrantConstraints {
  const out: GrantConstraints = { ...base };
  if (over.amount_limit) {
    const b = base.amount_limit?.max_per_item_cents;
    const o = over.amount_limit.max_per_item_cents;
    out.amount_limit = { ...(base.amount_limit ?? {}), ...over.amount_limit, max_per_item_cents: b === undefined ? o : Math.min(b, o) };
  }
  if (over.ownership) {
    out.ownership = !base.ownership || OWNERSHIP_ORDER[over.ownership] < OWNERSHIP_ORDER[base.ownership] ? over.ownership : base.ownership;
  }
  if (over.dimension_restriction) out.dimension_restriction = over.dimension_restriction;
  if (over.doc_types) out.doc_types = over.doc_types;
  if (over.period === 'open_only') out.period = 'open_only';
  if (over.delivered_to_me) out.delivered_to_me = true;
  if (over.assigned_to_me) out.assigned_to_me = true;
  return out;
}

/** H3 / H5 ceilings for a single (capability, action) given the audiences in play. */
export function ceilingAllows(capability: string, action: Action, audiences: readonly Audience[]): boolean {
  const def = CAPABILITY_BY_KEY.get(capability);
  if (!def || !(def.actions as readonly string[]).includes(action)) return false;
  const platform = audiences.includes('platform');
  // H5: platform capabilities only for platform audiences; platform roles hold no tenant data.
  if (def.module === 'platform' && !platform) return false;
  if (platform && def.module !== 'platform') return false;
  if (audiences.includes('external')) {
    if (action === 'post' || action === 'release' || action === 'configure') return false;
    if (action === 'approve' && def.tags.includes('money')) return false;
    if (def.tags.includes('locked')) return false;
    if (capability.startsWith('core.access.')) return false;
  }
  return true;
}

function envelopeAllows(envelope: ResolvedGrant[] | undefined, capability: string, action: Action): boolean {
  if (!envelope) return false; // client-owned source with no envelope → fail closed
  return envelope.some((g) => g.capability === capability && g.actions.includes(action));
}

function addGrant(
  caps: Map<string, Map<Action, GrantTrace[]>>,
  capability: string,
  action: Action,
  trace: GrantTrace,
): void {
  let byAction = caps.get(capability);
  if (!byAction) {
    byAction = new Map();
    caps.set(capability, byAction);
  }
  const list = byAction.get(action) ?? [];
  list.push(trace);
  byAction.set(action, list);
}

/** The grants one assignment contributes in a context (after narrowing + ceilings). */
function contribute(
  snapshot: AccessSnapshot,
  a: AssignmentInput,
  ctx: AccessContext,
  caps: Map<string, Map<Action, GrantTrace[]>>,
): void {
  const audiences: Audience[] = [snapshot.membership.audience, a.source.audience];
  const envelopeLoc = a.source.ownerLevel === 'client' ? a.source.locationId : null;
  if (a.source.ownerLevel === 'platform' && !audiences.includes('platform')) return; // templates are never assigned
  for (const g of a.grants) {
    const isConsol = g.capability.startsWith('consol.');
    if (ctx.kind === 'group' ? !isConsol : isConsol && ctx.kind !== 'any') continue;
    const muted = new Set(a.muted[g.capability] ?? []);
    for (const action of g.actions) {
      if (!(ACTIONS as readonly string[]).includes(action)) continue;
      if (a.readOnly && action !== 'view' && action !== 'export') continue;
      if (muted.has(action)) continue;
      if (!ceilingAllows(g.capability, action, audiences)) continue;
      if (envelopeLoc && !envelopeAllows(snapshot.envelopes[envelopeLoc], g.capability, action)) continue;
      addGrant(caps, g.capability, action, {
        assignmentId: a.id,
        grantType: a.grantType,
        sourceKey: a.source.key,
        sourceName: a.source.name,
        version: a.source.version,
        scopeType: a.scopeType,
        constraints: tightenConstraints(g.constraints ?? {}, a.constraintOverrides ?? {}),
      });
    }
  }
}

/**
 * Resolve the effective grant set for a context. Union of every active assignment whose
 * scope covers the context; narrowing applies per assignment; ceilings apply per grant.
 */
export function resolveEffectiveAccess(
  snapshot: AccessSnapshot,
  ctx: AccessContext,
  now: Date = new Date(),
): EffectiveAccess {
  const caps = new Map<string, Map<Action, GrantTrace[]>>();
  const result: EffectiveAccess = { membershipId: snapshot.membership.id, context: ctx, denied: null, capabilities: caps };
  if (snapshot.membership.status !== 'active') {
    result.denied = 'membership_inactive';
    return result;
  }
  const active = snapshot.assignments.filter((a) => isActive(a, now));

  if (ctx.kind === 'group') {
    // §3.9 validity: a group grant counts only while the holder can view reports on every member.
    const members = ctx.memberLocationIds;
    const valid =
      !members ||
      members.every((loc) =>
        can(resolveEffectiveAccess(snapshot, { kind: 'client', locationId: loc }, now), 'reports.financial', 'view').allow,
      );
    if (valid) for (const a of active) if (covers(a, ctx)) contribute(snapshot, a, ctx, caps);
    // IA Q4: all-clients roles holding reports.financial:view see every group (view only).
    const allClients = active.filter((a) => a.scopeType === 'all_clients');
    const tmp = new Map<string, Map<Action, GrantTrace[]>>();
    for (const a of allClients) contribute(snapshot, a, { kind: 'any' }, tmp);
    const viewers = tmp.get('reports.financial')?.get('view') ?? [];
    for (const t of viewers) {
      for (const k of ['consol.statements', 'consol.groups']) {
        addGrant(caps, k, 'view', { ...t, constraints: {}, implicit: true });
      }
    }
    return result;
  }

  for (const a of active) if (covers(a, ctx)) contribute(snapshot, a, ctx, caps);
  return result;
}

/** Decide one capability action (05 §1.8 steps 5–6; amount limits evaluated). */
export function can(
  effective: EffectiveAccess,
  capability: string,
  action: Action,
  resource: { amountCents?: number } = {},
): AccessDecision {
  const base: AccessDecision = { allow: false, reason: 'no_grant', trace: [], implied: false, limitCents: null, unevaluated: [] };
  if (effective.denied) return { ...base, reason: effective.denied };
  const def = CAPABILITY_BY_KEY.get(capability);
  if (!def || !(def.actions as readonly string[]).includes(action)) return { ...base, reason: 'unknown_capability' };
  const byAction = effective.capabilities.get(capability);
  let traces = byAction?.get(action) ?? [];
  let implied = false;
  if (traces.length === 0 && action === 'view' && byAction && byAction.size > 0) {
    // every action implies view (05 §2.1)
    traces = [...byAction.values()].flat();
    implied = true;
  }
  if (traces.length === 0) return base;

  const unevaluated = new Set<string>();
  const passing: GrantTrace[] = [];
  let limit: number | null = -1;
  for (const t of traces) {
    const c = t.constraints ?? {};
    for (const k of Object.keys(c)) if (k !== 'amount_limit') unevaluated.add(k);
    const al = c.amount_limit;
    const applies = al && (al.applies_to ?? LIMITED_BY_DEFAULT).includes(action);
    if (applies && resource.amountCents !== undefined && resource.amountCents > al.max_per_item_cents) continue;
    passing.push(t);
    if (!applies) limit = null;
    else if (limit !== null) limit = Math.max(limit, al.max_per_item_cents);
  }
  if (passing.length === 0) {
    return { ...base, reason: 'constraint:limit', trace: traces, implied, unevaluated: [...unevaluated] };
  }
  return {
    allow: true,
    reason: 'ok',
    trace: passing,
    implied,
    limitCents: limit === -1 ? null : limit,
    unevaluated: [...unevaluated],
  };
}

/** Compact `{capability: actions[]}` view (the shape /api/access/me will return in wave 3). */
export function capabilityMap(effective: EffectiveAccess): Record<string, Action[]> {
  const out: Record<string, Action[]> = {};
  for (const [cap, byAction] of effective.capabilities) {
    out[cap] = ACTIONS.filter((a) => (byAction.get(a)?.length ?? 0) > 0);
  }
  return out;
}

// ── Loader ────────────────────────────────────────────────────────────────────────

export interface MembershipRow { id: string; org_id: string; user_id: string; role: string; status: string; audience: string | null; access_epoch: number | string | null }
export interface AssignmentRow {
  id: string; org_id: string; membership_id: string; grant_type: string; role_id: string | null;
  permission_set_id: string | null; scope_type: string; location_id: string | null; client_set_id: string | null;
  group_id: string | null; read_only: boolean; muted: Record<string, string[]> | null;
  constraint_overrides: GrantConstraints | null; effective_from: string | null; effective_to: string | null; status: string;
}
export interface SourceRow {
  id: string; key: string; name: string; owner_level: string; location_id: string | null; audience: string;
  current_version: number | null; grants: Array<{ capability: string; actions: string[]; constraints: GrantConstraints | null }>;
}
export interface EnvelopeRow { location_id: string; grants: Array<{ capability: string; actions: string[]; constraints: GrantConstraints | null }> }

/** Minimal row-level reads the loader needs — implemented over Supabase or raw SQL (tests). */
export interface AccessDataSource {
  membership(membershipId: string): Promise<MembershipRow | null>;
  assignments(membershipId: string): Promise<AssignmentRow[]>;
  roles(ids: string[]): Promise<SourceRow[]>;
  permissionSets(ids: string[]): Promise<SourceRow[]>;
  clientSetMembers(setIds: string[]): Promise<Array<{ set_id: string; location_id: string }>>;
  envelopes(orgId: string, locationIds: string[]): Promise<EnvelopeRow[]>;
}

const AUDIENCES: readonly Audience[] = ['internal_staff', 'client_staff', 'external', 'platform'];
const asAudience = (s: string | null | undefined): Audience =>
  (AUDIENCES as readonly string[]).includes(s ?? '') ? (s as Audience) : 'internal_staff';
const asActions = (xs: readonly string[] | null | undefined): Action[] =>
  ACTIONS.filter((a) => (xs ?? []).includes(a));
const toGrants = (gs: SourceRow['grants']): ResolvedGrant[] =>
  gs.map((g) => ({ capability: g.capability, actions: asActions(g.actions), constraints: g.constraints ?? {} }));

export async function loadAccessSnapshot(src: AccessDataSource, membershipId: string): Promise<AccessSnapshot | null> {
  const m = await src.membership(membershipId);
  if (!m) return null;
  const rows = await src.assignments(membershipId);
  const roleIds = [...new Set(rows.map((r) => r.role_id).filter((x): x is string => !!x))];
  const setIds = [...new Set(rows.map((r) => r.permission_set_id).filter((x): x is string => !!x))];
  const csIds = [...new Set(rows.map((r) => r.client_set_id).filter((x): x is string => !!x))];
  const [roles, sets, csm] = await Promise.all([
    roleIds.length ? src.roles(roleIds) : Promise.resolve([]),
    setIds.length ? src.permissionSets(setIds) : Promise.resolve([]),
    csIds.length ? src.clientSetMembers(csIds) : Promise.resolve([]),
  ]);
  const byId = new Map<string, SourceRow>([...roles, ...sets].map((s) => [s.id, s]));
  const clientOwnedLocs = [...new Set([...roles, ...sets].filter((s) => s.owner_level === 'client' && s.location_id).map((s) => s.location_id!))];
  const env = clientOwnedLocs.length ? await src.envelopes(m.org_id, clientOwnedLocs) : [];

  const assignments: AssignmentInput[] = [];
  for (const r of rows) {
    const s = byId.get((r.role_id ?? r.permission_set_id) as string);
    if (!s) continue; // source unreadable → contributes nothing (fail closed)
    assignments.push({
      id: r.id,
      grantType: r.grant_type === 'permission_set' ? 'permission_set' : 'role',
      source: {
        id: s.id, key: s.key, name: s.name,
        ownerLevel: (['platform', 'tenant', 'client'].includes(s.owner_level) ? s.owner_level : 'tenant') as OwnerLevel,
        locationId: s.location_id, audience: asAudience(s.audience), version: s.current_version,
      },
      grants: toGrants(s.grants),
      scopeType: r.scope_type as ScopeType,
      locationId: r.location_id,
      clientSetId: r.client_set_id,
      clientSetLocationIds: csm.filter((x) => x.set_id === r.client_set_id).map((x) => x.location_id),
      groupId: r.group_id,
      readOnly: r.read_only === true,
      muted: Object.fromEntries(Object.entries(r.muted ?? {}).map(([k, v]) => [k, asActions(v)])),
      constraintOverrides: r.constraint_overrides ?? {},
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      status: r.status as AssignmentStatus,
    });
  }
  return {
    membership: {
      id: m.id,
      orgId: m.org_id,
      status: (['active', 'invited', 'suspended'].includes(m.status) ? m.status : 'suspended') as MembershipStatus,
      audience: asAudience(m.audience),
      accessEpoch: Number(m.access_epoch ?? 0),
    },
    assignments,
    envelopes: Object.fromEntries(env.map((e) => [e.location_id, toGrants(e.grants)])),
  };
}

type Row = Record<string, unknown>;

async function currentGrants(
  db: SupabaseClient,
  versionTable: 'role_versions' | 'permission_set_versions',
  grantTable: 'role_grants' | 'permission_set_grants',
  parentCol: 'role_id' | 'permission_set_id',
  versionCol: 'role_version_id' | 'permission_set_version_id',
  ids: string[],
): Promise<Map<string, SourceRow['grants']>> {
  const out = new Map<string, SourceRow['grants']>();
  const { data: versions, error } = await db.schema('core').from(versionTable).select(`id, ${parentCol}`).in(parentCol, ids).eq('state', 'published');
  if (error || !versions) return out;
  const vRows = versions as Row[];
  const vids = vRows.map((v) => String(v.id));
  if (vids.length === 0) return out;
  const { data: grants } = await db.schema('core').from(grantTable).select(`${versionCol}, capability, actions, constraints`).in(versionCol, vids);
  const parentOf = new Map(vRows.map((v) => [String(v.id), String(v[parentCol])]));
  for (const g of (grants ?? []) as Row[]) {
    const parent = parentOf.get(String(g[versionCol]));
    if (!parent) continue;
    const list = out.get(parent) ?? [];
    list.push({ capability: String(g.capability), actions: (g.actions as string[]) ?? [], constraints: (g.constraints as GrantConstraints) ?? {} });
    out.set(parent, list);
  }
  return out;
}

/** Supabase implementation (use the service-role client server-side; RLS also org-scopes reads). */
export function supabaseAccessSource(db: SupabaseClient): AccessDataSource {
  const sources = async (table: 'role_definitions' | 'permission_sets', ids: string[]): Promise<SourceRow[]> => {
    const { data, error } = await db.schema('core').from(table)
      .select('id, key, name, owner_level, location_id, audience, current_version').in('id', ids);
    if (error || !data) return [];
    const grants = table === 'role_definitions'
      ? await currentGrants(db, 'role_versions', 'role_grants', 'role_id', 'role_version_id', ids)
      : await currentGrants(db, 'permission_set_versions', 'permission_set_grants', 'permission_set_id', 'permission_set_version_id', ids);
    return (data as Row[]).map((r) => ({
      id: String(r.id), key: String(r.key), name: String(r.name), owner_level: String(r.owner_level),
      location_id: (r.location_id as string | null) ?? null, audience: String(r.audience),
      current_version: (r.current_version as number | null) ?? null, grants: grants.get(String(r.id)) ?? [],
    }));
  };
  return {
    async membership(id) {
      const { data, error } = await db.schema('core').from('memberships')
        .select('id, org_id, user_id, role, status, audience, access_epoch').eq('id', id).maybeSingle();
      return error || !data ? null : (data as MembershipRow);
    },
    async assignments(id) {
      const { data, error } = await db.schema('core').from('access_assignments').select('*').eq('membership_id', id);
      return error || !data ? [] : (data as AssignmentRow[]);
    },
    roles: (ids) => sources('role_definitions', ids),
    permissionSets: (ids) => sources('permission_sets', ids),
    async clientSetMembers(setIds) {
      const { data, error } = await db.schema('core').from('client_set_members').select('set_id, location_id').in('set_id', setIds);
      return error || !data ? [] : (data as Array<{ set_id: string; location_id: string }>);
    },
    async envelopes(orgId, locationIds) {
      const { data, error } = await db.schema('core').from('client_access_policies')
        .select('location_id, envelope_permission_set_id').eq('org_id', orgId).in('location_id', locationIds);
      if (error || !data) return [];
      const rows = (data as Row[]).filter((r) => r.envelope_permission_set_id);
      const envIds = [...new Set(rows.map((r) => String(r.envelope_permission_set_id)))];
      const grants = envIds.length
        ? await currentGrants(db, 'permission_set_versions', 'permission_set_grants', 'permission_set_id', 'permission_set_version_id', envIds)
        : new Map<string, SourceRow['grants']>();
      return rows.map((r) => ({ location_id: String(r.location_id), grants: grants.get(String(r.envelope_permission_set_id)) ?? [] }));
    },
  };
}

// ── Dual-run comparator (05 §5.7 R-11) ────────────────────────────────────────────

const FEATURE_ACTIONS: readonly FeatureAction[] = [
  'view', 'create', 'edit', 'approve', 'delete', 'export', 'request', 'post', 'resolve',
  'reconcile', 'manage', 'generate', 'run', 'assign',
];

export type ComparisonKind =
  | 'agree'
  | 'unmapped_cell'            // legacy cell has no capability (retired `payments::*`)
  | 'implied_view'             // new allows view only because another action is held
  | 'same_capability_other_key' // new allows via a capability the role already held through another legacy key
  | 'tighten'                  // a deliberate 05 §2.3 "tighten" row
  | 'scope'                    // legacy API decision ignores client scope (C9); new model scopes it
  | 'disagree';                // unexplained — blocks the flip

export interface LegacyComparison {
  feature: string;
  action: string;
  capability: string | null;
  locationId: string | null;
  legacyAllowed: boolean;
  newAllowed: boolean;
  kind: ComparisonKind;
  explained: boolean;
  trace: GrantTrace[];
}

/** 05 §2.3 rows that deliberately narrow access at backfill. */
export const TIGHTEN_CAPABILITIES: ReadonlySet<string> = new Set(['pay.vendor_bank_details:edit', 'consol.statements:view']);

export interface CompareInput {
  feature: string;
  action: string;
  /** The caller's legacy cells (role defaults ⊕ mig-130 overrides); null = unknown role (legacy denies). */
  legacyCells: ReadonlySet<LegacyCell> | null;
  /** The legacy decision as today's guard returned it (requirePermission — org-wide). */
  legacyAllowed: boolean;
  /** Legacy UI client scope; when given with locationId, the legacy decision is scoped like /api/me. */
  legacyScope?: { kind: LegacyScopeKind; assignedLocationIds: string[]; ownBooksLocationIds: string[] };
  locationId?: string | null;
  /** New-model effective access in the matching context (client when locationId, else any). */
  effective: EffectiveAccess;
}

function legacyScopeAllows(scope: NonNullable<CompareInput['legacyScope']>, locationId: string): boolean {
  if (scope.kind === 'all_clients') return true;
  if (scope.kind === 'all_except_own_books') return !scope.ownBooksLocationIds.includes(locationId);
  return scope.assignedLocationIds.includes(locationId);
}

/** Pure: compare one legacy decision with the new model's decision for its primary capability. */
export function compareDecision(input: CompareInput): LegacyComparison {
  const cell = legacyCell(input.feature, input.action);
  const primary = LEGACY_PRIMARY[cell] ?? null;
  const locationId = input.locationId ?? null;
  const out: LegacyComparison = {
    feature: input.feature, action: input.action, capability: primary, locationId,
    legacyAllowed: input.legacyAllowed, newAllowed: false, kind: 'agree', explained: true, trace: [],
  };
  if (!primary) {
    out.kind = 'unmapped_cell';
    return out;
  }
  const [capKey, capAction] = [primary.slice(0, primary.lastIndexOf(':')), primary.slice(primary.lastIndexOf(':') + 1) as Action];
  const d = can(input.effective, capKey, capAction);
  out.newAllowed = d.allow;
  out.trace = d.trace;

  let legacy = input.legacyAllowed;
  let scopedOut = false;
  if (legacy && locationId && input.legacyScope && !legacyScopeAllows(input.legacyScope, locationId)) {
    legacy = false;
    scopedOut = true;
  }
  if (legacy === d.allow) {
    out.kind = 'agree';
    return out;
  }
  if (d.allow && !legacy) {
    if (scopedOut) out.kind = 'disagree';
    else if (d.implied) out.kind = 'implied_view';
    else if (input.legacyCells && expandLegacyCells(input.legacyCells).get(capKey)?.has(capAction)) out.kind = 'same_capability_other_key';
    else out.kind = 'disagree';
  } else {
    if (TIGHTEN_CAPABILITIES.has(primary)) out.kind = 'tighten';
    else if (!locationId && input.legacyScope?.kind === 'assigned' && input.legacyScope.assignedLocationIds.length === 0) out.kind = 'scope';
    else out.kind = 'disagree';
  }
  out.explained = out.kind !== 'disagree';
  return out;
}

/** Shape for the dual-run sink (public.app_error_log via lib/observability/capture). */
export function toDualRunLogEntry(c: LegacyComparison, orgId: string, userId: string): {
  level: 'WARN'; source: 'api'; message: string; orgId: string; userId: string; meta: Record<string, unknown>;
} {
  return {
    level: 'WARN',
    source: 'api',
    message: `access dual-run ${c.kind}: ${c.feature}:${c.action} legacy=${c.legacyAllowed} new=${c.newAllowed}`,
    orgId,
    userId,
    meta: { ...c, trace: c.trace.map((t) => ({ source: t.sourceKey, version: t.version, scope: t.scopeType })) },
  };
}

/**
 * DB wrapper: today's requirePermission decision (employees.role, merged with mig-130
 * overrides) vs the new model for the same caller. Read-only; never throws (an error is
 * reported as a `disagree` with legacy=false/new=false so it is visible, not silent).
 */
export async function compareWithLegacy(
  db: SupabaseClient,
  params: { userId: string; orgId: string; feature: string; action: string; locationId?: string | null },
): Promise<LegacyComparison> {
  const { effectivePermission, resolveRoleKind, fetchOverrides } = await import('@/lib/rbac/resolve-permissions');
  const empty: EffectiveAccess = { membershipId: '', context: { kind: 'any' }, denied: 'membership_inactive', capabilities: new Map() };
  try {
    const { data: emp } = await db.schema('core').from('employees')
      .select('id, role').eq('clerk_user_id', params.userId).eq('org_id', params.orgId).eq('is_active', true).limit(1);
    const employee = ((emp ?? []) as Array<{ id: string; role: string | null }>)[0];
    const rawRole = employee?.role ?? null;
    const legacyAction = FEATURE_ACTIONS.find((a) => a === params.action);
    const legacyAllowed = rawRole && legacyAction
      ? await effectivePermission(db, params.orgId, rawRole, params.feature, legacyAction)
      : false;

    let legacyCells: Set<LegacyCell> | null = null;
    let legacyScope: CompareInput['legacyScope'];
    const kind = rawRole ? await resolveRoleKind(db, params.orgId, rawRole) : null;
    if (kind) {
      const overrides = await fetchOverrides(db, params.orgId, kind.roleKey);
      legacyCells = applyCellOverrides(kind.baseSystemRole ? legacyRoleCells(kind.baseSystemRole) : new Set(), overrides);
      const { data: els } = await db.from('employee_locations').select('location_id').eq('employee_id', employee!.id);
      const { data: own } = await db.schema('core').from('locations').select('id').eq('org_id', params.orgId).eq('is_management_company', true);
      legacyScope = {
        kind: kind.baseSystemRole ? legacyScopeKind(kind.baseSystemRole) : 'assigned',
        assignedLocationIds: ((els ?? []) as Array<{ location_id: string }>).map((r) => r.location_id),
        ownBooksLocationIds: ((own ?? []) as Array<{ id: string }>).map((r) => r.id),
      };
    }

    let effective = empty;
    const { data: user } = await db.schema('core').from('users').select('id').eq('clerk_user_id', params.userId).maybeSingle();
    if (user) {
      const { data: mem } = await db.schema('core').from('memberships')
        .select('id').eq('user_id', (user as { id: string }).id).eq('org_id', params.orgId).maybeSingle();
      if (mem) {
        const snap = await loadAccessSnapshot(supabaseAccessSource(db), (mem as { id: string }).id);
        if (snap) {
          effective = resolveEffectiveAccess(
            snap,
            params.locationId ? { kind: 'client', locationId: params.locationId } : { kind: 'any' },
          );
        }
      }
    }
    return compareDecision({
      feature: params.feature, action: params.action, legacyCells, legacyAllowed, legacyScope,
      locationId: params.locationId ?? null, effective,
    });
  } catch {
    return {
      feature: params.feature, action: params.action, capability: LEGACY_PRIMARY[legacyCell(params.feature, params.action)] ?? null,
      locationId: params.locationId ?? null, legacyAllowed: false, newAllowed: false, kind: 'disagree', explained: false, trace: [],
    };
  }
}
