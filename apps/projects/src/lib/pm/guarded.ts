import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { one, pm } from './db';

export interface JobRef {
  job_id: string;
  location_id: string;
  is_sample: boolean;
  stage_key: string;
}

/** The job as the caller's RLS sees it, or 404. */
export async function loadJob(db: SupabaseClient, jobId: string): Promise<JobRef> {
  const row = one<JobRef>(await pm(db).from('projects').select('job_id, location_id, is_sample, stage_key').eq('job_id', jobId).maybeSingle(), 'load job');
  if (!row) throw new HttpError(404, 'That job was not found in this workspace.', 'NOT_FOUND');
  return row;
}

/** Whether the job has an ACTIVE contract (emit_job_progress needs one). */
export async function hasActiveContract(db: SupabaseClient, jobId: string): Promise<boolean> {
  const res = await pm(db).from('contracts').select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('status', 'ACTIVE');
  return (res.count ?? 0) > 0;
}
