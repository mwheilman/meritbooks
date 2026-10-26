/**
 * Row shapes + low-level reads / writes for the migration tables (migration 193).
 *
 *   READS   through the caller's RLS client (org + client scope enforced by the database).
 *   WRITES  through the service role (members are SELECT-only on every 193 table), ONLY
 *           after the route's permission check and `assertWriteScope` on the client —
 *           every write pins org_id. This is the 171 / 184 / 188 pattern.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { fetchAll } from '@/lib/supabase/fetch-all';
import type { HistoryDepth, ProjectStage, ShadowMode, ChartStrategy, StagedEntity, SourceRole, SourceStatus, SourceTier } from '../types';
import { MigrationError } from './guard';

type DB = SupabaseClient;

export interface ProjectRow {
  id: string;
  org_id: string;
  location_id: string;
  wave_id: string | null;
  stage: ProjectStage;
  stage_changed_at: string;
  skipped_stages: string[];
  cutover_date: string | null;
  history_depth: HistoryDepth;
  history_start: string | null;
  target_go_live: string | null;
  shadow_mode: ShadowMode;
  chart_strategy: ChartStrategy;
  mapping_set_id: string | null;
  systems_confirmed: boolean;
  lead_user_id: string | null;
  preparer_user_id: string | null;
  reviewer_user_id: string | null;
  conversion_session_id: string | null;
  blocker_summary: Record<string, unknown>;
  certificate_id: string | null;
  certified_at: string | null;
  live_at: string | null;
  notes: string | null;
  created_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WaveRow {
  id: string;
  org_id: string;
  name: string;
  cutover_date: string;
  purpose: string | null;
  default_history_depth: HistoryDepth;
  target_go_live: string | null;
  status: 'open' | 'closed';
}

export interface SourceRow {
  id: string;
  org_id: string;
  location_id: string;
  project_id: string;
  system_id: string;
  role: SourceRole;
  tier: SourceTier;
  status: SourceStatus;
  entities: string[];
  last_run_id: string | null;
  last_pulled_at: string | null;
  note: string | null;
  created_at: string;
}

export interface RunRow {
  id: string;
  project_id: string;
  source_id: string | null;
  run_kind: 'file_parse' | 'pull' | 'opening_post' | 'undo';
  status: 'running' | 'staged' | 'superseded' | 'posted' | 'undone' | 'failed';
  entity: StagedEntity | null;
  parser: string | null;
  label: string | null;
  file_name: string | null;
  file_sha256: string | null;
  as_of: string | null;
  record_counts: Record<string, number>;
  control_totals: Record<string, number>;
  warnings: string[];
  dropped_count: number;
  error: string | null;
  created_by: string | null;
  created_at: string;
}

export interface StagedRow {
  id: string;
  project_id: string;
  run_id: string;
  entity: StagedEntity;
  external_id: string | null;
  display_name: string;
  dedupe_key: string | null;
  amount_cents: number;
  payload: Record<string, unknown>;
  source_ref: Record<string, unknown>;
  match_status: 'new' | 'matched' | 'merge_proposed' | 'conflict' | 'ignored';
  matched_object_id: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  decision_by: string | null;
  decision_at: string | null;
}

export const PROJECT_COLS =
  'id, org_id, location_id, wave_id, stage, stage_changed_at, skipped_stages, cutover_date, history_depth, history_start, target_go_live, shadow_mode, chart_strategy, mapping_set_id, systems_confirmed, lead_user_id, preparer_user_id, reviewer_user_id, conversion_session_id, blocker_summary, certificate_id, certified_at, live_at, notes, created_by, archived_at, created_at, updated_at';

/** One project, visible through the caller's RLS client — else a 404. */
export async function loadProject(db: DB, orgId: string, id: string): Promise<ProjectRow> {
  const { data, error } = await db.from('migration_projects').select(PROJECT_COLS).eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not load the migration: ${error.message}`);
  if (!data) throw new MigrationError('That client migration was not found.', 404, 'NOT_FOUND');
  return data as unknown as ProjectRow;
}

export async function loadSources(db: DB, projectId: string): Promise<SourceRow[]> {
  const { data, error } = await db
    .from('migration_sources')
    .select('id, org_id, location_id, project_id, system_id, role, tier, status, entities, last_run_id, last_pulled_at, note, created_at')
    .eq('project_id', projectId)
    .order('created_at');
  if (error) throw new Error(`Could not load sources: ${error.message}`);
  return (data ?? []) as unknown as SourceRow[];
}

export async function loadRuns(db: DB, projectId: string, opts: { activeOnly?: boolean } = {}): Promise<RunRow[]> {
  let q = db
    .from('migration_runs')
    .select('id, project_id, source_id, run_kind, status, entity, parser, label, file_name, file_sha256, as_of, record_counts, control_totals, warnings, dropped_count, error, created_by, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (opts.activeOnly) q = q.eq('status', 'staged');
  const { data, error } = await q;
  if (error) throw new Error(`Could not load files: ${error.message}`);
  return (data ?? []) as unknown as RunRow[];
}

/** Staged rows of the ACTIVE runs (superseded runs never count), optionally by entity. */
export async function loadStaged(db: DB, projectId: string, entities: ReadonlyArray<StagedEntity>): Promise<StagedRow[]> {
  const runs = await loadRuns(db, projectId, { activeOnly: true });
  const runIds = runs.map((r) => r.id);
  if (runIds.length === 0) return [];
  const { data, error } = await fetchAll(
    () =>
      db
        .from('staged_records')
        .select('id, project_id, run_id, entity, external_id, display_name, dedupe_key, amount_cents, payload, source_ref, match_status, matched_object_id, match_confidence, match_reason, decision_by, decision_at')
        .eq('project_id', projectId)
        .in('run_id', runIds)
        .in('entity', entities as string[]),
    { orderBy: 'id', label: 'migration staged records' },
  );
  if (error) throw new Error(`Could not load staged records: ${error.message}`);
  return ((data ?? []) as unknown as StagedRow[]).map((r) => ({ ...r, amount_cents: Number(r.amount_cents ?? 0) }));
}

/** Which source each active run came from (for "ledger vs field system" splits). */
export function runSourceRole(runs: ReadonlyArray<RunRow>, sources: ReadonlyArray<SourceRow>): Map<string, SourceRow | null> {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return new Map(runs.map((r) => [r.id, r.source_id ? byId.get(r.source_id) ?? null : null]));
}

export type EventKind =
  | 'created' | 'plan_updated' | 'stage_changed' | 'stage_skipped' | 'source_added' | 'source_removed'
  | 'source_status' | 'file_staged' | 'pull_staged' | 'preflight_run' | 'finding_decided'
  | 'mapping_proposed' | 'mapping_decided' | 'rule_settled' | 'master_decided' | 'opening_staged'
  | 'proof_signed' | 'certificate_issued' | 'certificate_voided' | 'went_live' | 'comment' | 'ask';

/** Append one event (service role, org pinned). Never throws — the trail is best-effort beside the real write. */
export async function logEvent(
  orgId: string,
  project: Pick<ProjectRow, 'id' | 'location_id'>,
  kind: EventKind,
  summary: string,
  opts: { actor?: string | null; system?: boolean; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await serviceWriter().from('migration_events').insert({
      org_id: orgId,
      location_id: project.location_id,
      project_id: project.id,
      kind,
      actor: opts.actor ?? null,
      actor_kind: opts.system ? 'system' : 'user',
      summary: summary.slice(0, 600),
      detail: opts.detail ?? {},
    });
  } catch (e) {
    console.warn('[onboarding-migration] event log failed:', e instanceof Error ? e.message : e);
  }
}

/** Patch a project (service role, org pinned). */
export async function patchProject(orgId: string, id: string, patch: Record<string, unknown>): Promise<ProjectRow> {
  const { data, error } = await serviceWriter()
    .from('migration_projects')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .select(PROJECT_COLS)
    .single();
  if (error) {
    if (/migration_projects_values_chk/.test(error.message) && 'reviewer_user_id' in patch) {
      throw new MigrationError('The reviewer has to be a different person from the preparer.', 422, 'SOD');
    }
    if (/migration_projects_wave_fk/.test(error.message)) {
      throw new MigrationError('A client in a wave moves on the wave’s cutover date. Pick the wave with that date, or leave the wave.', 422, 'WAVE_CUTOVER');
    }
    throw new Error(`Could not save the migration: ${error.message}`);
  }
  return data as unknown as ProjectRow;
}

export interface PersonRef {
  userId: string;
  name: string;
  role: string | null;
}

/** Active team members who can be lead / preparer / reviewer (RLS read of core.employees). */
export async function loadPeople(db: DB, orgId: string): Promise<PersonRef[]> {
  const { data } = await db
    .schema('core')
    .from('employees')
    .select('first_name, last_name, email, role, is_active, clerk_user_id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .limit(2000);
  const out: PersonRef[] = [];
  for (const e of (data ?? []) as Array<{ first_name: string | null; last_name: string | null; email: string | null; role: string | null; clerk_user_id: string | null }>) {
    if (!e.clerk_user_id) continue;
    const name = [e.first_name, e.last_name].filter(Boolean).join(' ').trim() || e.email || 'Team member';
    out.push({ userId: e.clerk_user_id, name, role: e.role });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ClientRef {
  id: string;
  name: string;
  shortCode: string;
}

/** Active clients the caller can see (RLS: org + client scope). */
export async function loadClients(db: DB, orgId: string): Promise<ClientRef[]> {
  const { data, error } = await db
    .schema('core')
    .from('locations')
    .select('id, name, short_code, is_active')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name')
    .limit(2000);
  if (error) throw new Error(`Could not load clients: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; name: string; short_code: string }>).map((l) => ({ id: l.id, name: l.name, shortCode: l.short_code }));
}
