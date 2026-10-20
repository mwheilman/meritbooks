import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pm, rows } from './db';
import type { ActivityRow } from './types';

export type ActivityScope = { jobId: string } | { companyIds: ReadonlyArray<string> };

export async function listActivity(db: SupabaseClient, scope: ActivityScope, limit = 50, before?: string): Promise<ActivityRow[]> {
  let q = pm(db).from('activity').select('id, location_id, job_id, actor_type, actor_id, verb, subject_table, subject_id, summary, meta, created_at');
  if ('jobId' in scope) q = q.eq('job_id', scope.jobId);
  else if (scope.companyIds.length) q = q.in('location_id', [...scope.companyIds]);
  if (before) q = q.lt('created_at', before);
  return rows<ActivityRow>(await q.order('created_at', { ascending: false }).limit(limit), 'activity');
}
