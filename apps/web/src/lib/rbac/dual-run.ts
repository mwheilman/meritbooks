/**
 * DUAL-RUN STATUS — the R-11 7-day dual-run read model and mode switch
 * (05-RBAC-SPEC §5.7 R-11, migration 164).
 *
 *   PURE  evaluateFlipEligibility(...)  — 7 full days in 'dual' AND 0 unexplained rows
 *   DB    loadDualRunStatus(admin, orgId)          (service-role client; caller gates admin)
 *         setEnforcementMode(admin, orgId, mode, actor)   → core.set_access_enforcement_mode
 *         explainDisagreements(admin, orgId, group, note, actor) → core.explain_access_dualrun
 *         requestEnforcementModeChange / confirm… / cancel…  → core.request_access_mode_change
 *             (mig 170): a DOWNGRADE from v2 waits for a SECOND tenant admin; with a single
 *             admin it applies with the logged reason. Every change is in the access log.
 *
 * The database re-checks eligibility inside set_access_enforcement_mode(), so the app's
 * computation is advisory UI, never the authority.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isEnforcementMode, type EnforcementMode } from '@/lib/rbac/authorize';

export const DUAL_RUN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DisagreementGroup {
  capability: string;
  action: string;
  route: string;
  kind: string;
  /** What today's permissions decided (true = allowed, so v2 would remove access). */
  legacyAllowed: boolean | null;
  explained: boolean;
  explanation: string | null;
  total: number;
  members: number;
  lastSeen: string;
}

export interface FlipEligibility {
  eligible: boolean;
  daysElapsed: number;
  daysRemaining: number;
  unexplained: number;
  blockers: string[];
}

/** A downgrade waiting for a second tenant admin (core.access_mode_change_requests). */
export interface PendingModeChange {
  id: string;
  fromMode: string;
  toMode: string;
  requestedBy: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  /** The viewer asked for it — they cannot confirm it themselves (H1). */
  mine: boolean;
}

export type ModeChangeOutcome =
  | { status: 'applied'; mode: EnforcementMode; previousMode: EnforcementMode; singleAdmin: boolean }
  | { status: 'pending'; mode: EnforcementMode; requestedMode: EnforcementMode; requestId: string }
  | { status: 'unchanged'; mode: EnforcementMode };

export interface DualRunStatus extends FlipEligibility {
  mode: EnforcementMode;
  pendingModeChange: PendingModeChange | null;
  dualRunStartedAt: string | null;
  modeChangedAt: string | null;
  windowDays: number;
  totals: { disagreements: number; explained: number; unexplained: number; members: number };
  groups: DisagreementGroup[];
}

/** Pure: may the tenant flip to v2 now? */
export function evaluateFlipEligibility(
  mode: EnforcementMode,
  dualRunStartedAt: string | null,
  unexplained: number,
  now: Date = new Date(),
): FlipEligibility {
  const started = dualRunStartedAt ? new Date(dualRunStartedAt).getTime() : NaN;
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0;
  const daysElapsed = Math.floor(elapsedMs / DAY_MS);
  const daysRemaining = Math.max(0, DUAL_RUN_DAYS - daysElapsed);
  const blockers: string[] = [];
  if (mode === 'v2') blockers.push('Already enforcing the capability model.');
  if (mode === 'legacy') blockers.push('Start the dual-run first: comparison is off in legacy mode.');
  if (mode === 'dual' && (!Number.isFinite(started) || elapsedMs < DUAL_RUN_DAYS * DAY_MS)) {
    blockers.push(`The dual-run needs ${DUAL_RUN_DAYS} full days (${daysRemaining} to go).`);
  }
  if (unexplained > 0) {
    blockers.push(`${unexplained} unexplained disagreement${unexplained === 1 ? '' : 's'} to review.`);
  }
  return { eligible: mode === 'dual' && blockers.length === 0, daysElapsed, daysRemaining, unexplained, blockers };
}

interface SummaryRow {
  capability: string;
  action: string;
  route: string;
  kind: string;
  legacy_decision: boolean | null;
  explained: boolean;
  explanation: string | null;
  total: number | string;
  members: number | string;
  last_seen: string;
}

async function loadPendingModeChange(
  admin: SupabaseClient,
  orgId: string,
  viewerUserId: string | null,
  now: Date,
): Promise<PendingModeChange | null> {
  const { data, error } = await admin.schema('core').from('access_mode_change_requests')
    .select('id, from_mode, to_mode, requested_by, reason, created_at, expires_at')
    .eq('org_id', orgId).eq('setting', 'access_enforcement_mode').eq('status', 'pending')
    .gt('expires_at', now.toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !data) return null; // table absent (pre-170) or nothing pending
  const r = data as { id: string; from_mode: string; to_mode: string; requested_by: string | null; reason: string; created_at: string; expires_at: string };
  return {
    id: r.id, fromMode: r.from_mode, toMode: r.to_mode, requestedBy: r.requested_by, reason: r.reason,
    createdAt: r.created_at, expiresAt: r.expires_at, mine: !!viewerUserId && r.requested_by === viewerUserId,
  };
}

export async function loadDualRunStatus(
  admin: SupabaseClient,
  orgId: string,
  now: Date = new Date(),
  viewerUserId: string | null = null,
): Promise<DualRunStatus> {
  const { data: org, error: orgErr } = await admin.schema('core').from('organizations')
    .select('access_enforcement_mode, dual_run_started_at, access_mode_changed_at')
    .eq('id', orgId).maybeSingle();
  if (orgErr) throw new Error(orgErr.message);
  if (!org) throw new Error('Organization not found');
  const o = org as { access_enforcement_mode: unknown; dual_run_started_at: string | null; access_mode_changed_at: string | null };
  const mode: EnforcementMode = isEnforcementMode(o.access_enforcement_mode) ? o.access_enforcement_mode : 'legacy';

  // Window: the current dual-run (when in dual), else the last 7 days.
  const sevenDaysAgo = new Date(now.getTime() - DUAL_RUN_DAYS * DAY_MS).toISOString();
  const since = mode === 'dual' && o.dual_run_started_at ? o.dual_run_started_at : sevenDaysAgo;
  const { data: rows, error } = await admin.schema('core').rpc('access_dualrun_summary', { p_org_id: orgId, p_since: since });
  if (error) throw new Error(error.message);

  const groups: DisagreementGroup[] = ((rows ?? []) as SummaryRow[]).map((r) => ({
    capability: r.capability,
    action: r.action,
    route: r.route,
    kind: r.kind,
    legacyAllowed: r.legacy_decision,
    explained: r.explained === true,
    explanation: r.explanation,
    total: Number(r.total),
    members: Number(r.members),
    lastSeen: r.last_seen,
  }));
  const explained = groups.filter((g) => g.explained).reduce((n, g) => n + g.total, 0);
  const unexplained = groups.filter((g) => !g.explained).reduce((n, g) => n + g.total, 0);
  const members = groups.reduce((n, g) => Math.max(n, g.members), 0);

  return {
    mode,
    pendingModeChange: await loadPendingModeChange(admin, orgId, viewerUserId, now),
    dualRunStartedAt: o.dual_run_started_at,
    modeChangedAt: o.access_mode_changed_at,
    windowDays: DUAL_RUN_DAYS,
    totals: { disagreements: explained + unexplained, explained, unexplained, members },
    groups,
    ...evaluateFlipEligibility(mode, o.dual_run_started_at, unexplained, now),
  };
}

/**
 * Tenant-admin gate for the dual-run screen, through the PDP: capability
 * core.access.roles:configure; the legacy side is today's team-admin rule
 * (requireManageUsers → ROLE_DEFINITIONS[employees.role].canManageUsers, i.e. company_admin).
 */
export async function authorizeAccessAdmin(ctx: { userId: string; orgId: string; supabase: SupabaseClient }): Promise<boolean> {
  const { authorize } = await import('@/lib/rbac/authorize');
  const { requireManageUsers } = await import('@/lib/team/guard');
  const decision = await authorize({ userId: ctx.userId, orgId: ctx.orgId }, 'core.access.roles', 'configure', {
    legacy: async () => (await requireManageUsers(ctx.supabase, ctx.userId, ctx.orgId)).ok === true,
    route: '/api/settings/access/dual-run',
  });
  return decision.allow;
}

export async function setEnforcementMode(
  admin: SupabaseClient,
  orgId: string,
  mode: EnforcementMode,
  actorClerkId: string,
): Promise<{ mode: EnforcementMode; previousMode: EnforcementMode }> {
  const { data, error } = await admin.schema('core').rpc('set_access_enforcement_mode', {
    p_org_id: orgId, p_mode: mode, p_actor: actorClerkId, p_force: false,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as { mode?: unknown; previous_mode?: unknown };
  return {
    mode: isEnforcementMode(r.mode) ? r.mode : mode,
    previousMode: isEnforcementMode(r.previous_mode) ? r.previous_mode : 'legacy',
  };
}

function toMode(v: unknown, fallback: EnforcementMode): EnforcementMode {
  return isEnforcementMode(v) ? v : fallback;
}

function toOutcome(raw: unknown, requested: EnforcementMode): ModeChangeOutcome {
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = toMode(r.mode, requested);
  if (r.status === 'pending') {
    return { status: 'pending', mode, requestedMode: toMode(r.requested_mode, requested), requestId: String(r.request_id ?? '') };
  }
  if (r.status === 'unchanged') return { status: 'unchanged', mode };
  return { status: 'applied', mode, previousMode: toMode(r.previous_mode, 'legacy'), singleAdmin: r.single_admin === true };
}

/**
 * The app's only way to change the mode (mig 170). The DB decides whether it applies now
 * or waits for a second tenant admin, re-checks the actor's seat and logs the change.
 * `actorUserId` is the caller's core.users.id.
 */
export async function requestEnforcementModeChange(
  admin: SupabaseClient,
  orgId: string,
  mode: EnforcementMode,
  actorUserId: string,
  reason: string,
  ip: string | null,
): Promise<ModeChangeOutcome> {
  const { data, error } = await admin.schema('core').rpc('request_access_mode_change', {
    p_org: orgId, p_setting: 'access_enforcement_mode', p_mode: mode, p_actor: actorUserId, p_reason: reason, p_ip: ip,
  });
  if (error) throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
  return toOutcome(data, mode);
}

export async function confirmEnforcementModeChange(
  admin: SupabaseClient,
  requestId: string,
  actorUserId: string,
  ip: string | null,
): Promise<ModeChangeOutcome> {
  const { data, error } = await admin.schema('core').rpc('confirm_access_mode_change', {
    p_request: requestId, p_actor: actorUserId, p_ip: ip,
  });
  if (error) throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
  return toOutcome(data, 'dual');
}

export async function cancelEnforcementModeChange(admin: SupabaseClient, requestId: string, actorUserId: string): Promise<void> {
  const { error } = await admin.schema('core').rpc('cancel_access_mode_change', { p_request: requestId, p_actor: actorUserId });
  if (error) throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
}

export async function explainDisagreements(
  admin: SupabaseClient,
  orgId: string,
  group: { capability: string; action: string; route: string },
  note: string,
  actorClerkId: string,
): Promise<number> {
  const { data, error } = await admin.schema('core').rpc('explain_access_dualrun', {
    p_org_id: orgId, p_capability: group.capability, p_action: group.action, p_route: group.route,
    p_note: note, p_actor: actorClerkId,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}
