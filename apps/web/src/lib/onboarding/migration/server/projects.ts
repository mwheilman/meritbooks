/**
 * Migration projects: create, plan, sources, the stage facts and the refresh that keeps
 * the stored stage / blocker summary honest (the Tower reads the stored copy; a client's
 * workspace recomputes live every time it opens).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getQboConfigStatus } from '@/lib/integrations/erp/quickbooks/config';
import { loadQboConnection } from '@/lib/integrations/erp/quickbooks/connection-store';
import { findCutoverPeriod, loadSession } from '@/lib/onboarding/session';
import { getSourceSystem, type SourceSystem } from '../catalog';
import { blockerSummary, deriveStages, nextAction, storedStage, type StageFacts } from '../stages';
import type { ChartStrategy, HistoryDepth, ShadowMode, Stage, StagedEntity } from '../types';
import { STAGES } from '../types';
import { longDate } from '../format';
import { MigrationError } from './guard';
import {
  PROJECT_COLS,
  loadProject,
  loadRuns,
  loadSources,
  logEvent,
  patchProject,
  type ProjectRow,
  type RunRow,
  type SourceRow,
} from './store';
import { computeProjectTies } from './certificate';

type DB = SupabaseClient;

export interface Ctx {
  supabase: DB;
  orgId: string;
  userId: string;
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * Security review LOW: a preparer / reviewer / lead must be an ACTIVE member of this org (Clerk
 * user id → core.users → an active core.memberships row). The sign-off gate compares these ids, so
 * a stranger's or a departed member's id must never be assignable. Service-role read (identity spine).
 */
export async function assertActiveOrgMembers(orgId: string, ids: ReadonlyArray<string | null | undefined>, reader?: SupabaseClient | null): Promise<void> {
  const want = Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)));
  if (want.length === 0) return;
  const db = reader ?? serviceWriter();
  const { data: users, error } = await db.schema('core').from('users').select('id, clerk_user_id').in('clerk_user_id', want);
  if (error) throw new MigrationError('Could not check the people on this migration. Try again.', 503, 'PEOPLE_CHECK');
  const byClerk = new Map(((users ?? []) as Array<{ id: string; clerk_user_id: string }>).map((u) => [u.clerk_user_id, u.id]));
  const userIds = Array.from(byClerk.values());
  const active = new Set<string>();
  if (userIds.length) {
    const { data: ms, error: mErr } = await db.schema('core').from('memberships').select('user_id').eq('org_id', orgId).eq('status', 'active').in('user_id', userIds);
    if (mErr) throw new MigrationError('Could not check the people on this migration. Try again.', 503, 'PEOPLE_CHECK');
    for (const m of (ms ?? []) as Array<{ user_id: string }>) active.add(m.user_id);
  }
  const bad = want.filter((id) => !active.has(byClerk.get(id) ?? ''));
  if (bad.length) throw new MigrationError('Pick a preparer and reviewer from this organization’s active team members.', 422, 'NOT_A_MEMBER');
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createProjects(
  ctx: Ctx,
  input: { locationIds: string[]; waveId?: string | null; preparerUserId?: string | null; reviewerUserId?: string | null },
): Promise<{ created: number; skipped: number; ids: string[] }> {
  await assertActiveOrgMembers(ctx.orgId, [input.preparerUserId, input.reviewerUserId]);
  const { data: existing } = await ctx.supabase
    .from('migration_projects')
    .select('location_id')
    .eq('org_id', ctx.orgId)
    .is('archived_at', null)
    .in('location_id', input.locationIds);
  const have = new Set(((existing ?? []) as Array<{ location_id: string }>).map((r) => r.location_id));
  let cutover: string | null = null;
  let depth: HistoryDepth = 'opening_only';
  if (input.waveId) {
    const { data: w } = await ctx.supabase.from('migration_waves').select('id, cutover_date, default_history_depth, status').eq('org_id', ctx.orgId).eq('id', input.waveId).maybeSingle();
    if (!w || (w as { status: string }).status !== 'open') throw new MigrationError('That wave was not found or is closed.', 404, 'NO_WAVE');
    cutover = (w as { cutover_date: string }).cutover_date;
    depth = (w as { default_history_depth: HistoryDepth }).default_history_depth;
  }
  const rows = input.locationIds
    .filter((id) => !have.has(id))
    .map((location_id) => ({
      org_id: ctx.orgId,
      location_id,
      wave_id: input.waveId ?? null,
      cutover_date: cutover,
      history_depth: depth,
      lead_user_id: ctx.userId,
      preparer_user_id: input.preparerUserId ?? null,
      reviewer_user_id: input.reviewerUserId && input.reviewerUserId !== input.preparerUserId ? input.reviewerUserId : null,
      created_by: ctx.userId,
    }));
  if (rows.length === 0) return { created: 0, skipped: input.locationIds.length, ids: [] };
  const { data, error } = await serviceWriter().from('migration_projects').insert(rows).select('id, location_id');
  if (error) throw new Error(`Could not start the migration: ${error.message}`);
  const created = (data ?? []) as Array<{ id: string; location_id: string }>;
  for (const p of created) await logEvent(ctx.orgId, p, 'created', 'Migration started', { actor: ctx.userId });
  return { created: created.length, skipped: input.locationIds.length - created.length, ids: created.map((p) => p.id) };
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PlanPatch {
  cutoverDate?: string | null;
  waveId?: string | null;
  historyDepth?: HistoryDepth;
  targetGoLive?: string | null;
  shadowMode?: ShadowMode;
  chartStrategy?: ChartStrategy;
  systemsConfirmed?: boolean;
  leadUserId?: string | null;
  preparerUserId?: string | null;
  reviewerUserId?: string | null;
  notes?: string | null;
}

/** The open wave for a cutover date, created when none exists (a wave IS a cutover date). */
async function waveForCutover(ctx: Ctx, cutover: string): Promise<string> {
  const { data } = await ctx.supabase.from('migration_waves').select('id').eq('org_id', ctx.orgId).eq('status', 'open').eq('cutover_date', cutover).maybeSingle();
  if (data) return (data as { id: string }).id;
  const { data: made, error } = await serviceWriter()
    .from('migration_waves')
    .insert({ org_id: ctx.orgId, name: `Wave · ${longDate(cutover)} cutover`, cutover_date: cutover, created_by: ctx.userId })
    .select('id')
    .single();
  if (error || !made) throw new Error(`Could not create the wave: ${error?.message ?? 'unknown'}`);
  return (made as { id: string }).id;
}

export async function updatePlan(ctx: Ctx, project: ProjectRow, patch: PlanPatch): Promise<ProjectRow> {
  if (project.stage === 'certified' || project.stage === 'live') {
    throw new MigrationError('This client is signed off — the plan is locked. Void the certificate to change it.', 409, 'LOCKED');
  }
  const p: Record<string, unknown> = {};
  const changes: string[] = [];

  // Wave and cutover move together.
  if (patch.waveId !== undefined && patch.waveId !== project.wave_id) {
    if (patch.waveId) {
      const { data: w } = await ctx.supabase.from('migration_waves').select('id, cutover_date, status').eq('org_id', ctx.orgId).eq('id', patch.waveId).maybeSingle();
      if (!w || (w as { status: string }).status !== 'open') throw new MigrationError('That wave was not found or is closed.', 404, 'NO_WAVE');
      p.wave_id = patch.waveId;
      p.cutover_date = (w as { cutover_date: string }).cutover_date;
      changes.push(`joined the ${longDate((w as { cutover_date: string }).cutover_date)} wave`);
    } else {
      p.wave_id = null;
      changes.push('left its wave');
    }
  }
  if (patch.cutoverDate !== undefined && patch.cutoverDate !== project.cutover_date && p.cutover_date === undefined) {
    if (patch.cutoverDate) {
      const period = await findCutoverPeriod(ctx.supabase, ctx.orgId, project.location_id, patch.cutoverDate);
      if (period?.status === 'HARD_CLOSE') {
        throw new MigrationError(`The month containing ${longDate(patch.cutoverDate)} is hard-closed for this client, so the opening entry couldn’t post there. Pick another cutover, or reopen that month first.`, 422, 'HARD_CLOSE');
      }
      p.cutover_date = patch.cutoverDate;
      // Changing a client's cutover moves it to the wave with that date (or creates one).
      p.wave_id = await waveForCutover(ctx, patch.cutoverDate);
      changes.push(`cutover set to ${longDate(patch.cutoverDate)}`);
    } else {
      p.cutover_date = null;
      p.wave_id = null;
      changes.push('cutover cleared (Unscheduled)');
    }
  }
  if (patch.historyDepth && patch.historyDepth !== project.history_depth) { p.history_depth = patch.historyDepth; changes.push('history depth changed'); }
  if (patch.targetGoLive !== undefined && patch.targetGoLive !== project.target_go_live) { p.target_go_live = patch.targetGoLive; changes.push(`target go-live ${patch.targetGoLive ? longDate(patch.targetGoLive) : 'cleared'}`); }
  if (patch.shadowMode && patch.shadowMode !== project.shadow_mode) { p.shadow_mode = patch.shadowMode; changes.push('practice-close mode changed'); }
  if (patch.chartStrategy && patch.chartStrategy !== project.chart_strategy) { p.chart_strategy = patch.chartStrategy; changes.push('chart strategy changed'); }
  if (patch.systemsConfirmed !== undefined && patch.systemsConfirmed !== project.systems_confirmed) { p.systems_confirmed = patch.systemsConfirmed; changes.push(patch.systemsConfirmed ? 'systems confirmed' : 'systems reopened'); }
  await assertActiveOrgMembers(ctx.orgId, [
    patch.leadUserId !== project.lead_user_id ? patch.leadUserId : null,
    patch.preparerUserId !== project.preparer_user_id ? patch.preparerUserId : null,
    patch.reviewerUserId !== project.reviewer_user_id ? patch.reviewerUserId : null,
  ]);
  if (patch.leadUserId !== undefined) p.lead_user_id = patch.leadUserId;
  if (patch.preparerUserId !== undefined) p.preparer_user_id = patch.preparerUserId;
  if (patch.reviewerUserId !== undefined) p.reviewer_user_id = patch.reviewerUserId;
  if (patch.leadUserId !== undefined || patch.preparerUserId !== undefined || patch.reviewerUserId !== undefined) changes.push('people changed');
  if (patch.notes !== undefined) p.notes = patch.notes;
  const prep = (p.preparer_user_id as string | null | undefined) ?? project.preparer_user_id;
  const rev = (p.reviewer_user_id as string | null | undefined) ?? project.reviewer_user_id;
  if (prep && rev && prep === rev) throw new MigrationError('The reviewer has to be a different person from the preparer.', 422, 'SOD');
  if (Object.keys(p).length === 0) return project;
  const next = await patchProject(ctx.orgId, project.id, p);
  if (changes.length > 0) await logEvent(ctx.orgId, project, 'plan_updated', `Plan: ${changes.join(', ')}`, { actor: ctx.userId });
  return next;
}

/** Skip a stage with a reason (part 1: only the practice close can be skipped). */
export async function skipStage(ctx: Ctx, project: ProjectRow, stage: Stage, reason: string): Promise<ProjectRow> {
  if (stage !== 'shadow_close') throw new MigrationError('Only the practice close can be skipped.', 422, 'NOT_SKIPPABLE');
  if (reason.trim().length < 10) throw new MigrationError('Say why in a sentence — it prints on the certificate.', 422, 'REASON');
  const skipped = Array.from(new Set([...(project.skipped_stages ?? []), stage]));
  const next = await patchProject(ctx.orgId, project.id, { skipped_stages: skipped });
  await logEvent(ctx.orgId, project, 'stage_skipped', `Practice close skipped: ${reason.trim()}`, { actor: ctx.userId, detail: { stage, reason: reason.trim() } });
  return next;
}

// ── Sources ──────────────────────────────────────────────────────────────────

export async function addSource(ctx: Ctx, project: ProjectRow, systemId: string): Promise<SourceRow> {
  const sys = getSourceSystem(systemId);
  if (!sys) throw new MigrationError('That system isn’t in the catalog. Choose “My system isn’t listed” to drop its files.', 422, 'UNKNOWN_SYSTEM');
  const { data, error } = await serviceWriter()
    .from('migration_sources')
    .upsert(
      { org_id: ctx.orgId, location_id: project.location_id, project_id: project.id, system_id: sys.id, role: sys.role, tier: sys.tier, entities: sys.entities, created_by: ctx.userId, status: 'planned' },
      { onConflict: 'project_id,system_id', ignoreDuplicates: true },
    )
    .select('id, org_id, location_id, project_id, system_id, role, tier, status, entities, last_run_id, last_pulled_at, note, created_at');
  if (error) throw new Error(`Could not add ${sys.name}: ${error.message}`);
  await logEvent(ctx.orgId, project, 'source_added', `${sys.name} added as a source`, { actor: ctx.userId, detail: { systemId: sys.id } });
  const row = (data ?? [])[0] as unknown as SourceRow | undefined;
  if (row) return row;
  const all = await loadSources(ctx.supabase, project.id);
  const found = all.find((s) => s.system_id === sys.id);
  if (!found) throw new Error('Source not saved');
  return found;
}

export async function removeSource(ctx: Ctx, project: ProjectRow, sourceId: string): Promise<void> {
  const sources = await loadSources(ctx.supabase, project.id);
  const src = sources.find((s) => s.id === sourceId);
  if (!src) throw new MigrationError('That source was not found.', 404, 'NOT_FOUND');
  const runs = await loadRuns(ctx.supabase, project.id);
  const used = runs.some((r) => r.source_id === sourceId && r.status === 'staged');
  const name = getSourceSystem(src.system_id)?.name ?? src.system_id;
  if (used) {
    // Keep the evidence: archive, and supersede its staged files so nothing counts.
    await serviceWriter().from('migration_runs').update({ status: 'superseded' }).eq('org_id', ctx.orgId).eq('project_id', project.id).eq('source_id', sourceId).eq('status', 'staged');
    await serviceWriter().from('migration_sources').update({ status: 'archived' }).eq('org_id', ctx.orgId).eq('id', sourceId);
  } else {
    await serviceWriter().from('migration_sources').delete().eq('org_id', ctx.orgId).eq('id', sourceId);
  }
  await logEvent(ctx.orgId, project, 'source_removed', `${name} removed`, { actor: ctx.userId });
}

// ── Facts → stage ────────────────────────────────────────────────────────────

export interface QboState {
  configured: boolean;
  connected: boolean;
  companyName: string | null;
}

export async function qboState(orgId: string): Promise<QboState> {
  const cfg = getQboConfigStatus();
  if (!cfg.configured) return { configured: false, connected: false, companyName: null };
  try {
    const rec = await loadQboConnection(createAdminSupabase(), orgId);
    return { configured: true, connected: rec?.status === 'connected', companyName: rec?.companyName ?? null };
  } catch {
    return { configured: true, connected: false, companyName: null };
  }
}

export interface SourceFileSlot {
  key: string;
  label: string;
  entity: StagedEntity;
  required: boolean;
  hint: string;
  run: Pick<RunRow, 'id' | 'file_name' | 'label' | 'created_at' | 'record_counts' | 'control_totals' | 'warnings' | 'parser' | 'as_of'> | null;
}

export interface SourceView {
  id: string;
  systemId: string;
  name: string;
  role: SourceRow['role'];
  tier: SourceRow['tier'];
  /** How it connects RIGHT NOW (QuickBooks without credentials falls back to the recipe). */
  path: 'connect' | 'recipe' | 'bank_feed';
  status: SourceRow['status'];
  pulled: boolean;
  lastPulledAt: string | null;
  files: SourceFileSlot[];
  missingRequired: number;
  system: SourceSystem | null;
}

export async function sourceViews(db: DB, orgId: string, project: ProjectRow, qbo: QboState): Promise<SourceView[]> {
  const sources = (await loadSources(db, project.id)).filter((s) => s.status !== 'archived');
  const runs = await loadRuns(db, project.id, { activeOnly: true });
  let plaidLinked = false;
  if (sources.some((s) => s.system_id === 'plaid')) {
    const { count } = await db.from('bank_accounts').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', project.location_id).not('plaid_account_id', 'is', null);
    plaidLinked = (count ?? 0) > 0;
  }
  return sources.map((s) => {
    const sys = getSourceSystem(s.system_id);
    const mine = runs.filter((r) => r.source_id === s.id);
    const path: SourceView['path'] = s.system_id === 'quickbooks' && qbo.configured && qbo.connected ? 'connect' : s.system_id === 'plaid' ? 'bank_feed' : 'recipe';
    const files: SourceFileSlot[] = (sys?.recipe.files ?? []).map((f) => {
      const run = mine.find((r) => r.entity === f.entity) ?? null;
      return {
        key: f.key,
        label: f.label,
        entity: f.entity,
        required: f.required,
        hint: f.hint,
        run: run ? { id: run.id, file_name: run.file_name, label: run.label, created_at: run.created_at, record_counts: run.record_counts, control_totals: run.control_totals, warnings: run.warnings, parser: run.parser, as_of: run.as_of } : null,
      };
    });
    const pulledByRun = path === 'connect' ? mine.some((r) => r.run_kind === 'pull') : mine.length > 0;
    const pulled = pulledByRun || (s.system_id === 'plaid' && plaidLinked);
    const missingRequired = path === 'recipe' ? files.filter((f) => f.required && !f.run).length : 0;
    return { id: s.id, systemId: s.system_id, name: sys?.name ?? s.system_id, role: s.role, tier: s.tier, path, status: s.status, pulled, lastPulledAt: s.last_pulled_at, files, missingRequired, system: sys };
  });
}

export interface ProjectFacts {
  facts: StageFacts;
  sources: SourceView[];
  qbo: QboState;
  session: { id: string; posted: boolean; postedEntryId: string | null } | null;
  certificate: { id: string; status: 'prepared' | 'issued' | 'voided'; number: string; preparedBy: string; approvedBy: string | null } | null;
}

export async function gatherFacts(db: DB, orgId: string, project: ProjectRow, opts: { withTies?: boolean } = {}): Promise<ProjectFacts> {
  const qbo = await qboState(orgId);
  const sources = await sourceViews(db, orgId, project, qbo);

  const { data: findings } = await db.from('preflight_findings').select('severity, disposition, amount_cents').eq('project_id', project.id);
  const f = (findings ?? []) as Array<{ severity: string; disposition: string; amount_cents: number }>;
  // A blocker is resolved only when CARRIED as a reconciling item ("fixed in source" waits for the re-check).
  const openBlockers = f.filter((x) => x.severity === 'blocker' && x.disposition !== 'carry_as_reconciling_item');
  const undecided = f.filter((x) => x.severity === 'warning' && x.disposition === 'open');

  const { data: maps } = await db.from('client_mappings').select('status, balance_cents, type_guard, type_reason').eq('project_id', project.id);
  const m = (maps ?? []) as Array<{ status: string; balance_cents: number; type_guard: string; type_reason: string | null }>;
  const withBal = m.filter((x) => Number(x.balance_cents) !== 0);
  const matched = withBal.filter((x) => x.status === 'accepted');

  let session: ProjectFacts['session'] = null;
  if (project.conversion_session_id) {
    const s = await loadSession(db, orgId, project.conversion_session_id);
    if (s) session = { id: s.id, posted: !!s.postedGlEntryId, postedEntryId: s.postedGlEntryId };
  }

  let certificate: ProjectFacts['certificate'] = null;
  if (project.certificate_id) {
    const { data: c } = await db.from('conversion_certificates').select('id, status, certificate_number, prepared_by, approved_by').eq('id', project.certificate_id).maybeSingle();
    if (c) {
      const r = c as { id: string; status: 'prepared' | 'issued' | 'voided'; certificate_number: string; prepared_by: string; approved_by: string | null };
      certificate = { id: r.id, status: r.status, number: r.certificate_number, preparedBy: r.prepared_by, approvedBy: r.approved_by };
    }
  }

  let tieDifferences = 0;
  let tieDifferenceCents = 0;
  if (opts.withTies && session?.posted && certificate?.status !== 'issued') {
    try {
      const t = await computeProjectTies(db, orgId, project);
      for (const tie of t.ties) {
        if (tie.status === 'difference' || tie.status === 'waiting') {
          tieDifferences++;
          tieDifferenceCents += tie.lines.reduce((mx, l) => Math.max(mx, Math.abs(l.differenceCents)), 0);
        }
      }
    } catch (e) {
      console.warn('[onboarding-migration] ties failed:', e instanceof Error ? e.message : e);
    }
  } else if (opts.withTies === false && project.blocker_summary && typeof project.blocker_summary.tieDifferences === 'number') {
    tieDifferences = project.blocker_summary.tieDifferences as number;
    tieDifferenceCents = Number(project.blocker_summary.tieDifferenceCents ?? 0);
  }

  const facts: StageFacts = {
    cutoverDate: project.cutover_date,
    systemsConfirmed: project.systems_confirmed,
    sourceCount: sources.length,
    sourcesPulled: sources.filter((s) => s.pulled).length,
    filesMissing: sources.reduce((t, s) => t + s.missingRequired, 0),
    preflightRan: f.length > 0,
    openBlockers: openBlockers.length,
    openBlockerCents: openBlockers.reduce((t, x) => t + Number(x.amount_cents ?? 0), 0),
    undecidedWarnings: undecided.length,
    balanceAccounts: withBal.length,
    balanceAccountsMatched: matched.length,
    unmatchedBalanceCents: withBal.filter((x) => x.status !== 'accepted').reduce((t, x) => t + Math.abs(Number(x.balance_cents)), 0),
    openingStaged: !!session,
    openingPosted: !!session?.posted,
    tieDifferences,
    tieDifferenceCents,
    proofSigned: !!certificate && certificate.status !== 'voided',
    shadowMode: project.shadow_mode,
    certificateIssued: certificate?.status === 'issued',
    live: !!project.live_at,
    skipped: (project.skipped_stages ?? []).filter((s): s is Stage => (STAGES as readonly string[]).includes(s)),
  };
  return { facts, sources, qbo, session, certificate };
}

/** Recompute and persist the stored stage + blocker summary (forward and backward, except sign-off / live). */
export async function refreshProject(db: DB, orgId: string, project: ProjectRow, opts: { withTies?: boolean; persist?: boolean } = { withTies: true }): Promise<{ project: ProjectRow; facts: ProjectFacts }> {
  const pf = await gatherFacts(db, orgId, project, opts);
  const stage = storedStage(pf.facts);
  const summary = blockerSummary(pf.facts);
  const next = nextAction(pf.facts);
  const { stages } = deriveStages(pf.facts);
  const blocker_summary = {
    ...summary,
    tieDifferences: pf.facts.tieDifferences,
    tieDifferenceCents: pf.facts.tieDifferenceCents,
    next,
    stages: stages.map((s) => ({ stage: s.stage, status: s.status, detail: s.detail })),
    sources: pf.sources.map((s) => ({ systemId: s.systemId, name: s.name, role: s.role, path: s.path, pulled: s.pulled, missing: s.missingRequired })),
    certificate: pf.certificate ? { number: pf.certificate.number, status: pf.certificate.status } : null,
  };
  const changedStage = stage !== project.stage && project.stage !== 'paused' && project.stage !== 'abandoned';
  // A read by someone outside the client's write scope recomputes but never persists.
  if (opts.persist === false) return { project: { ...project, blocker_summary, ...(changedStage ? { stage } : {}) }, facts: pf };
  const patch: Record<string, unknown> = { blocker_summary };
  if (changedStage) {
    patch.stage = stage;
    patch.stage_changed_at = new Date().toISOString();
  }
  const updated = await patchProject(orgId, project.id, patch);
  if (changedStage) await logEvent(orgId, project, 'stage_changed', `Moved to ${stages.find((s) => s.stage === stage)?.label ?? stage}`, { system: true, detail: { from: project.stage, to: stage } });
  return { project: updated, facts: pf };
}

export async function loadProjectForCaller(db: DB, orgId: string, id: string): Promise<ProjectRow> {
  return loadProject(db, orgId, id);
}

export { PROJECT_COLS };
