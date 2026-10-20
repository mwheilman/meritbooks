import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanSearch, one, pm, rows } from './db';
import type {
  JobOverviewRow, JobTypeRow, ProjectListRow, ProjectRow, StageDefRow, StageTransitionRow,
} from './types';

const LIST_COLS =
  'org_id, location_id, job_id, job_number, name, core_status, customer_id, customer_name, stage_key, stage_label, ' +
  'stage_sort, stage_is_terminal, stage_entered_at, job_type_key, job_type_label, archetype, pm_user_id, super_user_id, ' +
  'planned_start, planned_finish, is_sample, original_contract_cents, approved_co_cents, contract_revised_cents, ' +
  'pending_co_cents, budget_total_cents, cost_estimate_cents, created_at, updated_at';

const JOB_TYPE_COLS = 'id, location_id, key, label, archetype, billing_modes, default_billing_mode, progress_basis, stage_machine_key, modules, sort, is_active';
const STAGE_COLS = 'location_id, machine_key, stage_key, label, sort, core_status, is_terminal, is_initial';
const TRANSITION_COLS = 'location_id, machine_key, from_stage, to_stage, guards, approval_policy_key, sort';

export type ProjectSort = 'updated' | 'number' | 'name' | 'contract';

export interface ProjectFilters {
  /** Company scope. Empty = every company RLS lets the caller see. */
  companyIds: ReadonlyArray<string>;
  stage?: string | null;
  jobTypeKey?: string | null;
  q?: string | null;
  /** Hide terminal stages (closed, cancelled …). */
  openOnly?: boolean;
  sort?: ProjectSort;
  page?: number;
  perPage?: number;
}

export interface ProjectPage {
  rows: ProjectListRow[];
  total: number;
  page: number;
  perPage: number;
}

export async function listProjects(db: SupabaseClient, f: ProjectFilters): Promise<ProjectPage> {
  const perPage = Math.min(Math.max(f.perPage ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  let q = pm(db).from('v_project_list').select(LIST_COLS, { count: 'exact' });
  if (f.companyIds.length > 0) q = q.in('location_id', [...f.companyIds]);
  if (f.stage) q = q.eq('stage_key', f.stage);
  if (f.jobTypeKey) q = q.eq('job_type_key', f.jobTypeKey);
  if (f.openOnly) q = q.not('stage_is_terminal', 'is', true);
  const term = cleanSearch(f.q);
  if (term) q = q.or(`name.ilike.*${term}*,job_number.ilike.*${term}*,customer_name.ilike.*${term}*`);
  switch (f.sort ?? 'updated') {
    case 'number': q = q.order('job_number', { ascending: false, nullsFirst: false }); break;
    case 'name': q = q.order('name', { ascending: true }); break;
    case 'contract': q = q.order('contract_revised_cents', { ascending: false }); break;
    default: q = q.order('updated_at', { ascending: false });
  }
  q = q.order('job_id', { ascending: true }).range((page - 1) * perPage, page * perPage - 1);
  const res = await q;
  return { rows: rows<ProjectListRow>(res, 'list jobs'), total: res.count ?? 0, page, perPage };
}

/** Every job in scope, unpaginated (home roll-ups). Capped; `capped` says so. */
export async function listAllProjects(db: SupabaseClient, companyIds: ReadonlyArray<string>, cap = 1000): Promise<{ rows: ProjectListRow[]; capped: boolean }> {
  const res = await listProjects(db, { companyIds, perPage: cap, sort: 'updated' });
  return { rows: res.rows, capped: res.total > res.rows.length };
}

export interface JobDetail {
  list: ProjectListRow;
  project: ProjectRow;
  jobType: JobTypeRow;
}

export async function getProject(db: SupabaseClient, jobId: string): Promise<JobDetail | null> {
  const [listRes, projRes] = await Promise.all([
    pm(db).from('v_project_list').select(LIST_COLS).eq('job_id', jobId).maybeSingle(),
    pm(db).from('projects')
      .select('job_id, org_id, location_id, job_type_id, stage_key, stage_entered_at, pm_user_id, planned_start, planned_finish, actual_start, actual_finish, is_sample')
      .eq('job_id', jobId).maybeSingle(),
  ]);
  const list = one<ProjectListRow>(listRes, 'get job');
  const project = one<ProjectRow>(projRes, 'get project');
  if (!list || !project) return null;
  const jt = one<JobTypeRow>(await pm(db).from('job_types').select(JOB_TYPE_COLS).eq('id', project.job_type_id).maybeSingle(), 'get job type');
  if (!jt) return null;
  return { list, project, jobType: jt };
}

export async function getJobOverview(db: SupabaseClient, jobId: string): Promise<JobOverviewRow | null> {
  return one<JobOverviewRow>(await pm(db).from('v_job_overview').select('*').eq('job_id', jobId).maybeSingle(), 'job overview');
}

export interface StageOptions {
  /** Every active stage of the job's machine, in order. */
  stages: StageDefRow[];
  /** Allowed moves out of the current stage. */
  next: Array<StageTransitionRow & { label: string; core_status: StageDefRow['core_status'] | null }>;
}

export async function getStageOptions(db: SupabaseClient, locationId: string, machineKey: string, fromStage: string): Promise<StageOptions> {
  const [sRes, tRes] = await Promise.all([
    pm(db).from('stage_defs').select(STAGE_COLS).eq('location_id', locationId).eq('machine_key', machineKey).eq('is_active', true).order('sort'),
    pm(db).from('stage_transitions').select(TRANSITION_COLS).eq('location_id', locationId).eq('machine_key', machineKey).eq('from_stage', fromStage).order('sort'),
  ]);
  const stages = rows<StageDefRow>(sRes, 'stages');
  const byKey = new Map(stages.map((s) => [s.stage_key, s]));
  const next = rows<StageTransitionRow>(tRes, 'transitions')
    .filter((t) => byKey.has(t.to_stage))
    .map((t) => ({ ...t, label: byKey.get(t.to_stage)?.label ?? t.to_stage, core_status: byKey.get(t.to_stage)?.core_status ?? null }));
  return { stages, next };
}

export async function listJobTypes(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<JobTypeRow[]> {
  let q = pm(db).from('job_types').select(JOB_TYPE_COLS).eq('is_active', true);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<JobTypeRow>(await q.order('sort'), 'job types');
}

export interface StageMachine {
  locationId: string;
  machineKey: string;
  stages: StageDefRow[];
  transitions: StageTransitionRow[];
}

export async function listStageMachines(db: SupabaseClient, companyId: string): Promise<StageMachine[]> {
  const [sRes, tRes] = await Promise.all([
    pm(db).from('stage_defs').select(STAGE_COLS).eq('location_id', companyId).eq('is_active', true).order('sort'),
    pm(db).from('stage_transitions').select(TRANSITION_COLS).eq('location_id', companyId).order('sort'),
  ]);
  const stages = rows<StageDefRow>(sRes, 'stages');
  const transitions = rows<StageTransitionRow>(tRes, 'transitions');
  const keys = [...new Set(stages.map((s) => s.machine_key))];
  return keys.map((k) => ({
    locationId: companyId,
    machineKey: k,
    stages: stages.filter((s) => s.machine_key === k),
    transitions: transitions.filter((t) => t.machine_key === k),
  }));
}

/** Transitions for many companies (home: which open jobs are blocked). */
export async function listTransitions(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<StageTransitionRow[]> {
  let q = pm(db).from('stage_transitions').select(TRANSITION_COLS);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<StageTransitionRow>(await q.order('sort'), 'transitions');
}

export async function listStages(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<StageDefRow[]> {
  let q = pm(db).from('stage_defs').select(STAGE_COLS).eq('is_active', true);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<StageDefRow>(await q.order('sort'), 'stages');
}

/** Failing guard names for a job's move (pm.check_guards; nothing changes). */
export async function checkGuards(db: SupabaseClient, jobId: string, guards: ReadonlyArray<string>): Promise<string[]> {
  if (guards.length === 0) return [];
  const res = await pm(db).rpc('check_guards', { p_job: jobId, p_guards: [...guards] });
  if (res.error) return [];
  return Array.isArray(res.data) ? (res.data as string[]) : [];
}
