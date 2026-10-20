import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rows } from '@/lib/pm/db';
import { listCostCodes } from '@/lib/pm/budget';
import type { CostCodeRow } from '@/lib/pm/types';
import { LOG_COLS, PUNCH_COLS, TIME_COLS, type FieldLogRow, type PunchItemRow, type TimeEntryRow } from './types';
import type { Where } from './field-queries';

const pm = (db: SupabaseClient) => db.schema('pm');

/**
 * Field records (1100). pm.time_entries / field_logs / punch_items carry no company column,
 * so RLS bounds the org and the caller filters to the jobs in its view (inScope).
 */
export async function loadTime(db: SupabaseClient, w: Where, from: string, to: string, inScope: (jobId: string) => boolean): Promise<TimeEntryRow[]> {
  let q = pm(db).from('time_entries').select(TIME_COLS).gte('work_date', from).lte('work_date', to).neq('approval_state', 'VOID');
  if (w.jobId) q = q.eq('job_id', w.jobId);
  return rows<TimeEntryRow>(await q.order('work_date').order('created_at').limit(3000), 'time entries').filter((t) => inScope(t.job_id));
}

export async function loadCostCodesFor(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<CostCodeRow[]> {
  const lists = await Promise.all(companyIds.map((id) => listCostCodes(db, id)));
  return lists.flat();
}

/** Open work orders and production operations a time entry can point at. */
export async function loadTimeTargets(db: SupabaseClient, w: Where): Promise<{
  workOrders: Array<{ id: string; job_id: string; number: string | null; summary: string; kind: string }>;
  operations: Array<{ id: string; job_id: string; work_order_id: string; seq: number; name: string }>;
}> {
  if (!w.companyIds.length) return { workOrders: [], operations: [] };
  let wq = pm(db).from('work_orders').select('id, job_id, number, summary, kind').in('location_id', [...w.companyIds]).not('status', 'in', '(CLOSED,CANCELLED)');
  if (w.jobId) wq = wq.eq('job_id', w.jobId);
  const workOrders = rows<{ id: string; job_id: string; number: string | null; summary: string; kind: string }>(await wq.order('created_at', { ascending: false }).limit(800), 'open work orders');
  const prod = workOrders.filter((x) => x.kind === 'PRODUCTION').map((x) => x.id);
  const operations = prod.length
    ? rows<{ id: string; job_id: string; work_order_id: string; seq: number; name: string }>(
        await pm(db).from('wo_operations').select('id, job_id, work_order_id, seq, name').in('work_order_id', prod.slice(0, 300)).not('status', 'in', '(COMPLETE,SKIPPED)').order('seq'),
        'open operations',
      )
    : [];
  return { workOrders, operations };
}

export async function loadLogs(db: SupabaseClient, w: Where, inScope: (jobId: string) => boolean, limit = 300): Promise<FieldLogRow[]> {
  let q = pm(db).from('field_logs').select(LOG_COLS);
  if (w.jobId) q = q.eq('job_id', w.jobId);
  return rows<FieldLogRow>(await q.order('log_date', { ascending: false }).order('created_at', { ascending: false }).limit(limit), 'daily logs').filter((l) => inScope(l.job_id));
}

export async function loadPunch(db: SupabaseClient, w: Where, inScope: (jobId: string) => boolean): Promise<PunchItemRow[]> {
  let q = pm(db).from('punch_items').select(PUNCH_COLS);
  if (w.jobId) q = q.eq('job_id', w.jobId);
  return rows<PunchItemRow>(await q.order('created_at', { ascending: false }).limit(2000), 'punch items').filter((p) => inScope(p.job_id));
}
