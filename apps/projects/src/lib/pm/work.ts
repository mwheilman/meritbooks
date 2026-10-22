import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pm, rows } from './db';
import type { ChangeOrderRow, ContractRow, ProgressSnapshotRow, TaskRow } from './types';

const TASK_COLS = 'id, job_id, title, status, is_milestone, start_on, due_on, duration_days, sort, completed_at';
const CO_COLS = 'id, job_id, number, title, description, reason, stage, amount_cents, cost_impact_cents, schedule_days, created_by, approved_by, approved_at, created_at, updated_at';

export async function listTasks(db: SupabaseClient, jobId: string): Promise<TaskRow[]> {
  return rows<TaskRow>(await pm(db).from('tasks').select(TASK_COLS).eq('job_id', jobId).order('sort').order('start_on', { nullsFirst: false }), 'tasks');
}

/**
 * Open tasks due on or before `until` across the org (RLS scopes the org); the
 * caller filters to its company scope by job id. Overdue ones come first.
 */
export async function listOpenTasksDue(db: SupabaseClient, until: string, limit = 500): Promise<TaskRow[]> {
  return rows<TaskRow>(
    await pm(db).from('tasks').select(TASK_COLS).not('status', 'in', '(DONE,CANCELLED)').lte('due_on', until).order('due_on').limit(limit),
    'tasks due',
  );
}

/** Every open task with a date (company schedule). */
export async function listOpenTasks(db: SupabaseClient, limit = 1000): Promise<TaskRow[]> {
  return rows<TaskRow>(
    await pm(db).from('tasks').select(TASK_COLS).not('status', 'in', '(DONE,CANCELLED)').order('due_on', { nullsFirst: false }).limit(limit),
    'open tasks',
  );
}

export async function listChangeOrders(db: SupabaseClient, jobId: string): Promise<ChangeOrderRow[]> {
  return rows<ChangeOrderRow>(await pm(db).from('v_change_orders_masked').select(CO_COLS).eq('job_id', jobId).order('created_at', { ascending: false }), 'change orders');
}

/** Change orders across the org, optionally only open (PCO/COR). */
export async function listAllChangeOrders(db: SupabaseClient, opts: { openOnly?: boolean; limit?: number } = {}): Promise<ChangeOrderRow[]> {
  let q = pm(db).from('v_change_orders_masked').select(CO_COLS);
  if (opts.openOnly) q = q.in('stage', ['PCO', 'COR']);
  return rows<ChangeOrderRow>(await q.order('created_at', { ascending: false }).limit(opts.limit ?? 500), 'change orders');
}

export async function listContracts(db: SupabaseClient, jobId: string): Promise<ContractRow[]> {
  return rows<ContractRow>(
    await pm(db).from('contracts')
      .select('id, job_id, kind, number, title, original_cents, retention_pct, progress_basis, pct_complete, billing_mode, status, executed_on, created_at')
      .eq('job_id', jobId).order('created_at'),
    'contracts',
  );
}

export async function listSnapshots(db: SupabaseClient, jobId: string, limit = 12): Promise<ProgressSnapshotRow[]> {
  return rows<ProgressSnapshotRow>(
    await pm(db).from('progress_snapshots')
      .select('id, job_id, snapshot_version, as_of_date, trigger_name, contract_value_cents, cost_estimate_cents, pct_complete, pending_co_value_cents, emitted, suppressed_reason, created_at')
      .eq('job_id', jobId).order('snapshot_version', { ascending: false }).limit(limit),
    'progress snapshots',
  );
}
