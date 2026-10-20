/**
 * pm.onboarding_runs persistence (migration 1100 §5 + RLS §20).
 *
 *   columns: id, org_id (default get_org_id()), location_id (null = org-level run),
 *            status IN_PROGRESS|APPLIED|COMPLETE|ABANDONED,
 *            step describe|preview|bring_work|team|done, inputs jsonb, classification jsonb,
 *            plan jsonb, install_id, ai_decision_id, created_by, applied_at, completed_at
 *   unique:  one IN_PROGRESS run per (org, location) (nulls not distinct)
 *   member grants: insert (status IN_PROGRESS, install_id null);
 *                  update (step, status, inputs, classification, plan, ai_decision_id, completed_at)
 *                  WITH CHECK status in (IN_PROGRESS, ABANDONED, COMPLETE)
 *
 * Consequence: an APPLIED run (set by pm.apply_pack_plan, step bring_work) cannot be
 * updated by the app except to COMPLETE. Steps 3 and 4 therefore resume at
 * "bring_work" until the user finishes (reported to the lead as a gap).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClassifyResponse, RunBrief, RunInputs, RunStatus, RunStep } from './types';

export interface RunRow {
  id: string;
  location_id: string | null;
  status: RunStatus;
  step: RunStep;
  inputs: RunInputs | null;
  classification: ClassifyResponse | null;
  ai_decision_id: string | null;
  install_id: string | null;
  updated_at: string;
}

const COLS = 'id, location_id, status, step, inputs, classification, ai_decision_id, install_id, updated_at';

export function runBrief(r: RunRow): RunBrief {
  return {
    id: r.id,
    status: r.status,
    step: r.step,
    inputs: r.inputs ?? {},
    classification: r.classification ?? null,
    aiDecisionId: r.ai_decision_id,
    installId: r.install_id,
  };
}

export async function listRuns(db: SupabaseClient): Promise<{ rows: RunRow[]; error: { code?: string; message?: string } | null }> {
  const { data, error } = await db.schema('pm').from('onboarding_runs').select(COLS).order('updated_at', { ascending: false }).limit(200);
  return { rows: (data ?? []) as RunRow[], error };
}

/** Latest run per location (and the org-level run under key ''), preferring the open one. */
export function latestRuns(rows: RunRow[]): Map<string, RunRow> {
  const out = new Map<string, RunRow>();
  for (const r of rows) {
    const key = r.location_id ?? '';
    const cur = out.get(key);
    if (!cur) { out.set(key, r); continue; }
    if (cur.status !== 'IN_PROGRESS' && r.status === 'IN_PROGRESS') out.set(key, r);
  }
  return out;
}

export async function openRun(db: SupabaseClient, locationId: string | null): Promise<RunRow | null> {
  let q = db.schema('pm').from('onboarding_runs').select(COLS).eq('status', 'IN_PROGRESS');
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { data } = await q.limit(1).maybeSingle();
  return (data as RunRow | null) ?? null;
}

/** The open run for a location, created if missing (race-safe on the open-run unique index). */
export async function ensureRun(db: SupabaseClient, locationId: string | null, inputs: RunInputs = {}): Promise<{ run: RunRow | null; error: string | null }> {
  const existing = await openRun(db, locationId);
  if (existing) return { run: existing, error: null };
  const { data, error } = await db
    .schema('pm')
    .from('onboarding_runs')
    .insert({ location_id: locationId, status: 'IN_PROGRESS', step: 'describe', inputs })
    .select(COLS)
    .single();
  if (!error && data) return { run: data as RunRow, error: null };
  if (error?.code === '23505') {
    const again = await openRun(db, locationId);
    if (again) return { run: again, error: null };
  }
  return { run: null, error: error?.message ?? 'Could not start the onboarding run' };
}

export interface RunPatch {
  step?: RunStep;
  status?: 'IN_PROGRESS' | 'ABANDONED' | 'COMPLETE';
  inputs?: RunInputs;
  classification?: ClassifyResponse | null;
  plan?: unknown;
  ai_decision_id?: string | null;
  completed_at?: string | null;
}

export async function patchRun(db: SupabaseClient, id: string, patch: RunPatch): Promise<string | null> {
  const { error } = await db.schema('pm').from('onboarding_runs').update(patch).eq('id', id);
  return error ? error.message : null;
}

/** Merge into inputs of the open run (creating it if needed). Best effort; returns the run id. */
export async function saveRunInputs(db: SupabaseClient, locationId: string | null, inputs: RunInputs, extra: Omit<RunPatch, 'inputs'> = {}): Promise<string | null> {
  const { run } = await ensureRun(db, locationId, inputs);
  if (!run) return null;
  await patchRun(db, run.id, { ...extra, inputs: { ...(run.inputs ?? {}), ...inputs } });
  return run.id;
}

/** Finish a company: its open or applied run → COMPLETE / done. */
export async function completeCompanyRun(db: SupabaseClient, locationId: string | null, inputs?: RunInputs): Promise<string | null> {
  let q = db.schema('pm').from('onboarding_runs').select(COLS).in('status', ['IN_PROGRESS', 'APPLIED']);
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { data, error } = await q.order('updated_at', { ascending: false });
  if (error) return error.message;
  for (const r of (data ?? []) as RunRow[]) {
    const err = await patchRun(db, r.id, {
      status: 'COMPLETE', step: 'done', completed_at: new Date().toISOString(),
      ...(inputs ? { inputs: { ...(r.inputs ?? {}), ...inputs } } : {}),
    });
    if (err) return err;
  }
  return null;
}
