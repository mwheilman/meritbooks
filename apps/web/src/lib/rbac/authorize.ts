/**
 * AUTHORIZE — the single policy decision point (05-RBAC-SPEC §5.1, R-11 · wave 2A).
 *
 *   authorize(ctx, capability, action, resource?)        → AuthorizeDecision
 *   authorizeAny(ctx, refs[], resource?)                 → allow when ANY ref is allowed
 *   authorizeLegacyCell(ctx, feature, action, resource?) → for the legacy guards
 *
 * Every decision runs in the tenant's ENFORCEMENT MODE (core.organizations
 * .access_enforcement_mode, migration 164):
 *
 *   legacy → the legacy decision only (v2 is not computed).
 *   dual   → BOTH are computed; the LEGACY decision is returned, so nothing a user can do
 *            changes. Any disagreement is written to core.access_dualrun_log —
 *            asynchronously, deduped, and a log failure never blocks or throws.
 *   v2     → the capability-model decision is returned. For post / approve / release the
 *            database re-decides (core.assert_actor_capability) and both must allow.
 *   (mode unreadable) → both are computed and BOTH must allow (fail closed).
 *
 * The LEGACY decision is supplied by the call site (`resource.legacy`) exactly as it was
 * computed before R-11 (requirePermission / page-guard / canApprove keep their own
 * code), so dual mode is behavior-preserving by construction. Without a thunk, the
 * default evaluator reads core.employees.role + mig-130 overrides like requirePermission.
 *
 * The V2 decision is effective-access.ts over a snapshot of the caller's membership,
 * cached per (membership_id, access_epoch) — mig 160 bumps the epoch on every
 * assignment change / publish, so a revocation applies on the next request (05 §5.4).
 *
 * DOLLAR LIMITS (wave 2G, 05 §3.4). When the call site passes `amountCents` for an
 * approve / post / release, the v2 decision also requires the held grant's per-item
 * limit to cover it (lib/rbac/limits.ts withinApprovalLimit, evaluated on the SAME
 * snapshot — no second read). Over the limit = v2 deny (reason 'over_limit'): enforced
 * in v2 mode, logged as a dual-run disagreement in dual mode (legacy still decides).
 * Transaction SoD stays with the call sites (assertActionSod); `preparedBy` and the rest
 * of the resource still reach the `constraints` hook for future rules.
 *
 * ROUTE LABEL (wave 2G). The dual-run log groups by `resource.route` — a STATIC label the
 * call site passes. Request headers are never used (`next-url` is client-controlled).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { CAPABILITY_BY_KEY, type Action } from '@/lib/rbac/capabilities';
import {
  LEGACY_PRIMARY,
  MONEY_APPROVE_CELLS,
  applyCellOverrides,
  expandLegacyCells,
  legacyCell,
  legacyRoleCells,
  type GrantMap,
} from '@/lib/rbac/legacy-map';
import {
  TIGHTEN_CAPABILITIES,
  can,
  loadAccessSnapshot,
  resolveEffectiveAccess,
  supabaseAccessSource,
  type AccessSnapshot,
} from '@/lib/rbac/effective-access';
import type { FeatureAction } from '@/lib/rbac/permissions';
import { approvalLimitCheck, type LimitResult } from '@/lib/rbac/limits';

// ── Types ─────────────────────────────────────────────────────────────────────────

export const ENFORCEMENT_MODES = ['legacy', 'dual', 'v2'] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

/** Classification of a legacy-vs-v2 disagreement (core.access_dualrun_log.kind). */
export type DualRunKind =
  | 'disagree' //                  unexplained — blocks the flip
  | 'tighten' //                   a deliberate 05 §2.3 "tighten" row
  | 'implied_view' //              v2 allows view only because another action is held
  | 'unmapped_cell' //             a retired legacy cell (`payments::*`)
  | 'same_capability_other_key' // v2 allows via a capability another legacy key granted
  | 'scope' //                     legacy ignores client scope (C9); v2 scopes it
  | 'money_kind' //                v2 narrows money approval to the item's own kind (05 §5.1, C3) — needs acknowledgement
  | 'v2_error'; //                 v2 could not be computed — unexplained

/**
 * Kinds that are expected by construction and do not block the flip. `money_kind` is
 * deliberately NOT here: it is the intended C3 narrowing (05 §5.1) but it REMOVES money
 * authority someone uses today, so a tenant admin must acknowledge it (or the backfill
 * must grant the kind's capability) before v2.
 */
export const EXPLAINED_KINDS: ReadonlySet<DualRunKind> = new Set<DualRunKind>([
  'tighten',
  'implied_view',
  'unmapped_cell',
  'same_capability_other_key',
  'scope',
]);

export interface CapabilityRef {
  capability: string;
  action: Action;
}

export interface AuthorizeContext {
  /** Clerk user id of the actor. */
  userId: string;
  /** Resolved Books tenant uuid. */
  orgId: string;
}

export interface AuthorizeResource {
  /** Client context. null / absent = org-level (holds it on at least one client). */
  locationId?: string | null;
  /** Wave 2C hook (dollar limits). Passed to deps.constraints only; NOT evaluated here. */
  amountCents?: number;
  /** Wave 2C hook (transaction SoD). Passed to deps.constraints only; NOT evaluated here. */
  preparedBy?: string | null;
  /** Route / surface label for the dual-run log (defaults to the request path). */
  route?: string;
  /** The legacy decision exactly as the call site computed it before R-11. */
  legacy?: () => Promise<boolean>;
  /** The legacy (feature, action) this check replaces (classification + default legacy). */
  legacyCell?: { feature: string; action: string };
  /**
   * Broader refs the legacy check was equivalent to. When v2 denies `refs` but would
   * allow these, the disagreement is the expected per-kind narrowing ('money_kind').
   */
  equivalentRefs?: readonly CapabilityRef[];
}

export interface AuthorizeDecision {
  allow: boolean;
  mode: EnforcementMode | 'unknown';
  legacy: boolean | null;
  v2: boolean | null;
  reason: string;
  disagreement: DualRunKind | null;
  membershipId: string | null;
}

export interface V2RefDecision {
  allow: boolean;
  implied: boolean;
  reason: string;
}

/** The caller's resolved v2 access in one context. */
export interface V2Access {
  membershipId: string | null;
  decide(ref: CapabilityRef): V2RefDecision;
  /** Dollar-limit check for a held ref (05 §3.4). Absent = no limits known (allow). */
  limit?(ref: CapabilityRef, amountCents: number): LimitResult;
}

export interface DualRunLogEntry {
  orgId: string;
  membershipId: string | null;
  clerkUserId: string;
  capability: string;
  action: string;
  locationId: string | null;
  legacyDecision: boolean | null;
  v2Decision: boolean | null;
  route: string;
  kind: DualRunKind;
  explained: boolean;
  reason: string;
  detail: Record<string, unknown>;
}

export interface AuthorizeDeps {
  mode(orgId: string): Promise<EnforcementMode | null>;
  legacy(ctx: AuthorizeContext, refs: readonly CapabilityRef[], resource: AuthorizeResource): Promise<boolean>;
  v2(ctx: AuthorizeContext, locationId: string | null): Promise<V2Access>;
  /** DB-side decision for post / approve / release in v2 mode (core.assert_actor_capability). */
  dbCheck(ctx: AuthorizeContext, ref: CapabilityRef, locationId: string | null): Promise<boolean>;
  /**
   * The caller's legacy access expanded to capabilities (05 §2.3), used ONLY to classify a
   * dual-run "v2 allows, legacy denies" as `same_capability_other_key`. null = unknown.
   */
  legacyGrants(ctx: AuthorizeContext): Promise<GrantMap | null>;
  /** Wave 2C constraint evaluator (limits / SoD). Receives the v2 allow; returns the final allow. */
  constraints(allow: boolean, ctx: AuthorizeContext, refs: readonly CapabilityRef[], resource: AuthorizeResource): Promise<boolean>;
  log(entry: DualRunLogEntry): Promise<void>;
  route(): Promise<string | null>;
}

// ── Constants ─────────────────────────────────────────────────────────────────────

/** Acts the database re-decides in v2 mode (05 §5.2.2). */
export const MONEY_CRITICAL_ACTIONS: ReadonlySet<Action> = new Set<Action>(['post', 'approve', 'release']);

/** Acts a per-item dollar limit applies to (05 §3.4). */
export const LIMITED_ACTIONS: ReadonlySet<Action> = MONEY_CRITICAL_ACTIONS;

export type MoneyApprovalKind = 'AR_REFUND' | 'AP_DISBURSEMENT' | 'AP_BATCH' | 'PAYROLL_RUN';

/** Approval kind → capability (mirrors core.rbac_money_kind_capability, migration 164). */
export const MONEY_KIND_CAPABILITY: Readonly<Record<MoneyApprovalKind, string>> = {
  AR_REFUND: 'pay.refunds',
  AP_DISBURSEMENT: 'pay.batches',
  AP_BATCH: 'pay.batches',
  PAYROLL_RUN: 'payroll.runs',
};

export function parseRef(ref: string): CapabilityRef {
  const i = ref.lastIndexOf(':');
  return { capability: ref.slice(0, i), action: ref.slice(i + 1) as Action };
}

/** Today's "may approve money at all" (any of bills / checks / payroll approve) in v2 terms. */
export const MONEY_APPROVE_REFS: readonly CapabilityRef[] = MONEY_APPROVE_CELLS.map((c) => parseRef(LEGACY_PRIMARY[c]));

/**
 * Retired coarse legacy cells (05 §2.3: `payments` was a fallback superset; its holders
 * get the granular keys). v2 allows them when ANY granular equivalent is held.
 */
export const RETIRED_CELL_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  'payments::view': ['pay.customer_payments:view', 'pay.batches:view', 'payroll.runs:view'],
  'payments::run': [
    'pay.customer_payments:create', 'pay.batches:create', 'pay.batches:release', 'payroll.runs:release',
    'exp.reimbursements:release', // /api/expenses/{batch,[id]/reimburse} gate on payments:run today
  ],
};

/** The capability refs a legacy (feature, action) gate is checked against in v2. */
export function refsForLegacyCell(feature: string, action: string): CapabilityRef[] {
  const cell = legacyCell(feature, action);
  const primary = LEGACY_PRIMARY[cell];
  if (primary) return [parseRef(primary)];
  return (RETIRED_CELL_ALTERNATIVES[cell] ?? []).map(parseRef);
}

const refKey = (r: CapabilityRef): string => `${r.capability}:${r.action}`;

// ── Classification (pure) ─────────────────────────────────────────────────────────

export function classifyDisagreement(input: {
  legacy: boolean;
  v2: boolean | null;
  v2Implied: boolean;
  refs: readonly CapabilityRef[];
  legacyCell?: { feature: string; action: string };
  equivalentAllowed: boolean;
  /** v2 allowed via a capability:action the caller's OTHER legacy keys already granted. */
  heldViaOtherLegacyKey?: boolean;
}): DualRunKind {
  if (input.v2 === null) return 'v2_error';
  // A retired coarse cell (`payments::*`) is compared through its granular equivalents.
  if (input.legacyCell && !LEGACY_PRIMARY[legacyCell(input.legacyCell.feature, input.legacyCell.action)]) return 'unmapped_cell';
  if (input.v2 && !input.legacy) {
    if (input.v2Implied) return 'implied_view';
    if (input.heldViaOtherLegacyKey) return 'same_capability_other_key';
    return 'disagree';
  }
  // legacy allows, v2 denies
  if (input.refs.some((r) => TIGHTEN_CAPABILITIES.has(refKey(r)))) return 'tighten';
  if (input.equivalentAllowed) return 'money_kind';
  return 'disagree';
}

// ── Dual-run log sink (async, deduped, never throws) ──────────────────────────────

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const DEDUPE_MAX = 5000;
const recentlyLogged = new Map<string, number>();
const pendingLogs = new Set<Promise<void>>();

function shouldLog(key: string, nowMs: number): boolean {
  const until = recentlyLogged.get(key);
  if (until !== undefined && until > nowMs) return false;
  if (recentlyLogged.size >= DEDUPE_MAX) {
    const oldest = recentlyLogged.keys().next().value;
    if (oldest !== undefined) recentlyLogged.delete(oldest);
  }
  recentlyLogged.delete(key);
  recentlyLogged.set(key, nowMs + DEDUPE_WINDOW_MS);
  return true;
}

function enqueueLog(deps: AuthorizeDeps, entry: DualRunLogEntry): void {
  const key = [entry.orgId, entry.clerkUserId, entry.capability, entry.action, entry.locationId ?? '', entry.route, entry.kind].join('|');
  if (!shouldLog(key, Date.now())) return;
  let p: Promise<void>;
  try {
    p = Promise.resolve(deps.log(entry)).catch(() => undefined);
  } catch {
    return; // a synchronously throwing sink is swallowed too
  }
  pendingLogs.add(p);
  void p.finally(() => pendingLogs.delete(p));
}

/** Test / shutdown helper: wait for in-flight dual-run log writes. */
export async function flushDualRunLogs(): Promise<void> {
  await Promise.all([...pendingLogs]);
}

/** Test helper: forget the dedupe window. */
export function resetDualRunDedupe(): void {
  recentlyLogged.clear();
}

// ── The decision ──────────────────────────────────────────────────────────────────

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

interface V2Result {
  allow: boolean | null; // null = could not be computed
  implied: boolean;
  reason: string;
  membershipId: string | null;
  allowedRef: CapabilityRef | null;
  equivalentAllowed: boolean;
}

async function computeV2(
  d: AuthorizeDeps,
  ctx: AuthorizeContext,
  refs: readonly CapabilityRef[],
  resource: AuthorizeResource,
): Promise<V2Result> {
  try {
    const access = await d.v2(ctx, resource.locationId ?? null);
    let reason = refs.length === 0 ? 'no_capability_mapped' : 'no_grant';
    for (const ref of refs) {
      const r = access.decide(ref);
      if (r.allow && resource.amountCents !== undefined && LIMITED_ACTIONS.has(ref.action) && access.limit) {
        // Held, but is the amount within this person's limit for it? (another ref may cover it)
        if (!access.limit(ref, resource.amountCents).allowed) {
          reason = 'over_limit';
          continue;
        }
      }
      if (r.allow) {
        const allow = await d.constraints(true, ctx, refs, resource);
        return {
          allow, implied: r.implied, reason: allow ? 'ok' : 'constraint', membershipId: access.membershipId,
          allowedRef: allow ? ref : null, equivalentAllowed: false,
        };
      }
      reason = r.reason;
    }
    const equivalentAllowed = (resource.equivalentRefs ?? []).some((ref) => access.decide(ref).allow);
    return { allow: false, implied: false, reason, membershipId: access.membershipId, allowedRef: null, equivalentAllowed };
  } catch (e) {
    return {
      allow: null, implied: false, reason: `v2_error: ${e instanceof Error ? e.message : String(e)}`,
      membershipId: null, allowedRef: null, equivalentAllowed: false,
    };
  }
}

export async function authorizeAny(
  ctx: AuthorizeContext,
  refs: readonly CapabilityRef[],
  resource: AuthorizeResource = {},
  deps: Partial<AuthorizeDeps> = {},
): Promise<AuthorizeDecision> {
  const d: AuthorizeDeps = { ...DEFAULT_DEPS, ...deps };
  const legacyOf = (): Promise<boolean> =>
    safe(() => (resource.legacy ? resource.legacy() : d.legacy(ctx, refs, resource)), false);

  const mode = await safe(() => d.mode(ctx.orgId), null);

  if (mode === 'legacy') {
    const legacy = await legacyOf();
    return { allow: legacy, mode, legacy, v2: null, reason: legacy ? 'ok' : 'legacy_deny', disagreement: null, membershipId: null };
  }

  if (mode === 'v2') {
    const v2 = await computeV2(d, ctx, refs, resource);
    let allow = v2.allow === true;
    let reason = v2.reason;
    if (allow && v2.allowedRef && MONEY_CRITICAL_ACTIONS.has(v2.allowedRef.action)) {
      const ref = v2.allowedRef;
      allow = await safe(() => d.dbCheck(ctx, ref, resource.locationId ?? null), false);
      if (!allow) reason = 'db_deny';
    }
    return { allow, mode, legacy: null, v2: v2.allow, reason, disagreement: null, membershipId: v2.membershipId };
  }

  // dual, or the mode could not be read
  const [legacy, v2] = await Promise.all([legacyOf(), computeV2(d, ctx, refs, resource)]);
  if (mode === null) {
    const allow = legacy && v2.allow === true;
    return { allow, mode: 'unknown', legacy, v2: v2.allow, reason: allow ? 'ok' : 'mode_unknown_fail_closed', disagreement: null, membershipId: v2.membershipId };
  }

  let disagreement: DualRunKind | null = null;
  if (legacy !== v2.allow) {
    let heldViaOtherLegacyKey = false;
    const allowedRef = v2.allowedRef;
    if (v2.allow === true && !legacy && !v2.implied && allowedRef) {
      const grants = await safe(() => d.legacyGrants(ctx), null);
      heldViaOtherLegacyKey = grants?.get(allowedRef.capability)?.has(allowedRef.action) === true;
    }
    disagreement = classifyDisagreement({
      legacy, v2: v2.allow, v2Implied: v2.implied, refs, legacyCell: resource.legacyCell,
      equivalentAllowed: v2.equivalentAllowed, heldViaOtherLegacyKey,
    });
    const route = resource.route ?? (await safe(() => d.route(), null)) ?? 'unknown';
    const capability = refs.length > 0 ? [...new Set(refs.map((r) => r.capability))].join('|')
      : resource.legacyCell ? `legacy:${resource.legacyCell.feature}` : 'unknown';
    const action = refs[0]?.action ?? resource.legacyCell?.action ?? 'unknown';
    enqueueLog(d, {
      orgId: ctx.orgId,
      membershipId: v2.membershipId,
      clerkUserId: ctx.userId,
      capability,
      action,
      locationId: resource.locationId ?? null,
      legacyDecision: legacy,
      v2Decision: v2.allow,
      route,
      kind: disagreement,
      explained: EXPLAINED_KINDS.has(disagreement),
      reason: v2.reason,
      detail: {
        refs: refs.map(refKey),
        ...(resource.legacyCell ? { legacy_cell: legacyCell(resource.legacyCell.feature, resource.legacyCell.action) } : {}),
        ...(resource.amountCents !== undefined ? { amount_cents: resource.amountCents } : {}),
      },
    });
  }
  return { allow: legacy, mode, legacy, v2: v2.allow, reason: legacy ? 'ok' : 'legacy_deny', disagreement, membershipId: v2.membershipId };
}

export function authorize(
  ctx: AuthorizeContext,
  capability: string,
  action: Action,
  resource: AuthorizeResource = {},
  deps: Partial<AuthorizeDeps> = {},
): Promise<AuthorizeDecision> {
  return authorizeAny(ctx, [{ capability, action }], resource, deps);
}

/** For the legacy guards: check a (feature, action) cell through its mapped capability. */
export function authorizeLegacyCell(
  ctx: AuthorizeContext,
  feature: string,
  action: FeatureAction | string,
  resource: AuthorizeResource = {},
  deps: Partial<AuthorizeDeps> = {},
): Promise<AuthorizeDecision> {
  return authorizeAny(ctx, refsForLegacyCell(feature, action), { ...resource, legacyCell: { feature, action } }, deps);
}

// ── Default (DB) dependencies ─────────────────────────────────────────────────────

async function adminDb(): Promise<SupabaseClient> {
  const { createAdminSupabase } = await import('@/lib/supabase/admin');
  return createAdminSupabase() as unknown as SupabaseClient;
}

const MODE_TTL_MS = 30_000;
const modeCache = new Map<string, { mode: EnforcementMode; until: number }>();

/** Drop the cached mode (call after a flip so it takes effect on this instance at once). */
export function invalidateEnforcementModeCache(orgId?: string): void {
  if (orgId) modeCache.delete(orgId);
  else modeCache.clear();
}

export function isEnforcementMode(v: unknown): v is EnforcementMode {
  return typeof v === 'string' && (ENFORCEMENT_MODES as readonly string[]).includes(v);
}

async function readMode(orgId: string): Promise<EnforcementMode | null> {
  const hit = modeCache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.mode;
  const db = await adminDb();
  const { data, error } = await db.schema('core').from('organizations')
    .select('access_enforcement_mode').eq('id', orgId).maybeSingle();
  if (error) {
    // Migration 164 not applied yet → the column does not exist → legacy behavior.
    if (error.code === '42703' || /access_enforcement_mode/.test(error.message ?? '')) return 'legacy';
    throw new Error(error.message);
  }
  const raw = (data as { access_enforcement_mode?: unknown } | null)?.access_enforcement_mode;
  const mode: EnforcementMode = isEnforcementMode(raw) ? raw : 'legacy';
  modeCache.set(orgId, { mode, until: Date.now() + MODE_TTL_MS });
  return mode;
}

async function employeeRole(db: SupabaseClient, ctx: AuthorizeContext): Promise<string | null> {
  const { data } = await db.schema('core').from('employees')
    .select('role').eq('clerk_user_id', ctx.userId).eq('org_id', ctx.orgId).eq('is_active', true).limit(1);
  return ((data ?? []) as Array<{ role: string | null }>)[0]?.role ?? null;
}

const LEGACY_GRANTS_TTL_MS = 60_000;
const legacyGrantsCache = new Map<string, { grants: GrantMap | null; until: number }>();

/** The caller's legacy cells (employees.role ⊕ mig-130 overrides) expanded to capabilities. */
async function defaultLegacyGrants(ctx: AuthorizeContext): Promise<GrantMap | null> {
  const key = `${ctx.orgId}:${ctx.userId}`;
  const hit = legacyGrantsCache.get(key);
  if (hit && hit.until > Date.now()) return hit.grants;
  const db = await adminDb();
  const rawRole = await employeeRole(db, ctx);
  let grants: GrantMap | null = null;
  if (rawRole) {
    const rp = await import('@/lib/rbac/resolve-permissions');
    const kind = await rp.resolveRoleKind(db, ctx.orgId, rawRole);
    if (kind?.baseSystemRole) {
      const cells = applyCellOverrides(legacyRoleCells(kind.baseSystemRole), await rp.fetchOverrides(db, ctx.orgId, kind.roleKey));
      grants = expandLegacyCells(cells);
    }
  }
  if (legacyGrantsCache.size >= 1000) legacyGrantsCache.clear();
  legacyGrantsCache.set(key, { grants, until: Date.now() + LEGACY_GRANTS_TTL_MS });
  return grants;
}

/** Default legacy evaluator — the requirePermission source (employees.role + mig-130). */
async function defaultLegacy(ctx: AuthorizeContext, refs: readonly CapabilityRef[], resource: AuthorizeResource): Promise<boolean> {
  const db = await adminDb();
  if (resource.legacyCell) {
    const rawRole = await employeeRole(db, ctx);
    if (!rawRole) return false;
    const rp = await import('@/lib/rbac/resolve-permissions');
    return rp.effectivePermission(db, ctx.orgId, rawRole, resource.legacyCell.feature, resource.legacyCell.action as FeatureAction);
  }
  const grants = await defaultLegacyGrants(ctx);
  if (!grants) return false;
  return refs.some((r) => {
    const held = grants.get(r.capability);
    return !!held && (held.has(r.action) || (r.action === 'view' && held.size > 0));
  });
}

// Snapshot cache keyed (membership_id, access_epoch): a revocation bumps the epoch.
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_MAX = 500;
const snapshotCache = new Map<string, { snap: AccessSnapshot; until: number }>();

export function clearAccessSnapshotCache(): void {
  snapshotCache.clear();
}

async function cachedSnapshot(db: SupabaseClient, membershipId: string, epoch: number): Promise<AccessSnapshot | null> {
  const key = `${membershipId}:${epoch}`;
  const hit = snapshotCache.get(key);
  if (hit && hit.until > Date.now()) return hit.snap;
  const snap = await loadAccessSnapshot(supabaseAccessSource(db), membershipId);
  if (!snap) return null;
  if (snapshotCache.size >= SNAPSHOT_MAX) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
  snapshotCache.set(key, { snap, until: Date.now() + SNAPSHOT_TTL_MS });
  return snap;
}

const DENY_ALL = (membershipId: string | null, reason: string): V2Access => ({
  membershipId,
  decide: () => ({ allow: false, implied: false, reason }),
});

async function defaultV2(ctx: AuthorizeContext, locationId: string | null): Promise<V2Access> {
  const db = await adminDb();
  const { data: user, error: uErr } = await db.schema('core').from('users')
    .select('id').eq('clerk_user_id', ctx.userId).maybeSingle();
  if (uErr) throw new Error(uErr.message);
  if (!user) return DENY_ALL(null, 'no_membership');
  const { data: mem, error: mErr } = await db.schema('core').from('memberships')
    .select('id, access_epoch').eq('user_id', (user as { id: string }).id).eq('org_id', ctx.orgId).maybeSingle();
  if (mErr) throw new Error(mErr.message);
  if (!mem) return DENY_ALL(null, 'no_membership');
  const m = mem as { id: string; access_epoch: number | string | null };
  const snap = await cachedSnapshot(db, m.id, Number(m.access_epoch ?? 0));
  if (!snap) return DENY_ALL(m.id, 'no_membership');
  return v2AccessFromSnapshot(snap, locationId);
}

/** Pure: the v2 evaluator for one snapshot + context (also used by tests). */
export function v2AccessFromSnapshot(snap: AccessSnapshot, locationId: string | null, now: Date = new Date()): V2Access {
  const effective = resolveEffectiveAccess(snap, locationId ? { kind: 'client', locationId } : { kind: 'any' }, now);
  const context = locationId ? { kind: 'client' as const, locationId } : { kind: 'any' as const };
  return {
    membershipId: snap.membership.id,
    decide(ref) {
      if (!CAPABILITY_BY_KEY.has(ref.capability)) return { allow: false, implied: false, reason: 'unknown_capability' };
      const r = can(effective, ref.capability, ref.action);
      return { allow: r.allow, implied: r.implied, reason: r.reason };
    },
    limit(ref, amountCents) {
      return approvalLimitCheck(snap, `${ref.capability}:${ref.action}`, amountCents, context, now);
    },
  };
}

async function defaultDbCheck(ctx: AuthorizeContext, ref: CapabilityRef, locationId: string | null): Promise<boolean> {
  const db = await adminDb();
  const { data, error } = await db.schema('core').rpc('assert_actor_capability', {
    p_org_id: ctx.orgId,
    p_clerk_user_id: ctx.userId,
    p_capability: ref.capability,
    p_action: ref.action,
    p_location_id: locationId,
  });
  if (error) return false; // 42501 in v2 = deny; any other error fails closed
  return data === true;
}

async function defaultLog(e: DualRunLogEntry): Promise<void> {
  const db = await adminDb();
  const { error } = await db.schema('core').from('access_dualrun_log').insert({
    org_id: e.orgId,
    membership_id: e.membershipId,
    clerk_user_id: e.clerkUserId,
    capability: e.capability,
    action: e.action,
    location_id: e.locationId,
    legacy_decision: e.legacyDecision,
    v2_decision: e.v2Decision,
    route: e.route,
    kind: e.kind,
    explained: e.explained,
    reason: e.reason.slice(0, 500),
    detail: e.detail,
  });
  if (error) console.warn('[access dual-run] log insert failed:', error.message);
}

/**
 * No implicit route label: request headers (`next-url`, `x-invoke-path`, …) can be set
 * by the client, which would let a caller file its disagreements under another route's
 * explanation. Call sites pass `resource.route`; otherwise the label is 'unknown'.
 */
async function defaultRoute(): Promise<string | null> {
  return null;
}

export const DEFAULT_DEPS: AuthorizeDeps = {
  mode: readMode,
  legacy: defaultLegacy,
  legacyGrants: defaultLegacyGrants,
  v2: defaultV2,
  dbCheck: defaultDbCheck,
  constraints: async (allow) => allow, // wave 2C: dollar limits + SoD plug in here
  log: defaultLog,
  route: defaultRoute,
};
