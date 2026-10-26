/**
 * THE rev-rec method resolver (A5, migration 194 slice). One precedence, used by billing
 * (credit Revenue vs Deferred Revenue at invoice time), the JOB_PROGRESS interim recognizer and
 * the month-end WIP engine — so billing and recognition can never disagree about a stream:
 *
 *   1. the job's override                     core.jobs.rev_rec_method_override
 *   2. the per-revenue-type method            revenue_type_methods (the job's revenue account,
 *                                             or the billed line's account for an invoice line)
 *   3. the legacy job_type → method map       rev_rec_method_map (job_type, else archetype)
 *   4. the company default                    core.locations.rev_rec_method
 *
 * `resolveRevRecMethod` is the PURE core (maps already loaded — the WIP engine resolves hundreds
 * of jobs per run); `resolveJobRevRecMethod` loads the four sources for one job / line.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobRevRecRow, RevRecMethod } from '@/lib/services/rev-rec';

type DB = SupabaseClient;

export const DEFAULT_REV_REC_METHOD: RevRecMethod = 'PCT_COSTS_INCURRED';

export function resolveRevRecMethod(
  job: Pick<JobRevRecRow, 'job_type' | 'archetype' | 'rev_rec_method_override' | 'revenue_account_id'>,
  jobTypeMap: Map<string, RevRecMethod>,
  companyDefault: RevRecMethod,
  revenueTypeMap?: Map<string, RevRecMethod>,
): RevRecMethod {
  if (job.rev_rec_method_override) return job.rev_rec_method_override;
  if (revenueTypeMap && job.revenue_account_id && revenueTypeMap.has(job.revenue_account_id)) {
    return revenueTypeMap.get(job.revenue_account_id) as RevRecMethod;
  }
  const key = job.job_type ?? job.archetype ?? null;
  if (key && jobTypeMap.has(key)) return jobTypeMap.get(key) as RevRecMethod;
  return companyDefault;
}

/**
 * Resolve for one job (and/or one billed revenue account) from the database. A revenue
 * account passed explicitly (an invoice line's account) wins over the job's own revenue
 * account for step 2; with neither, step 2 is skipped.
 */
export async function resolveJobRevRecMethod(
  db: DB,
  args: { orgId: string; locationId: string; jobId?: string | null; revenueAccountId?: string | null },
): Promise<RevRecMethod> {
  let job: Pick<JobRevRecRow, 'job_type' | 'archetype' | 'rev_rec_method_override' | 'revenue_account_id'> = {
    job_type: null, archetype: null, rev_rec_method_override: null, revenue_account_id: null,
  };
  if (args.jobId) {
    const { data } = await db.schema('core').from('jobs')
      .select('rev_rec_method_override, job_type, archetype, revenue_account_id')
      .eq('org_id', args.orgId).eq('id', args.jobId).maybeSingle();
    const j = data as Partial<typeof job> | null;
    if (j) {
      job = {
        rev_rec_method_override: j.rev_rec_method_override ?? null,
        job_type: j.job_type ?? null,
        archetype: j.archetype ?? null,
        revenue_account_id: j.revenue_account_id ?? null,
      };
    }
  }
  if (job.rev_rec_method_override) return job.rev_rec_method_override;
  const revenueAccountId = args.revenueAccountId ?? job.revenue_account_id ?? null;

  const revenueTypeMap = new Map<string, RevRecMethod>();
  if (revenueAccountId) {
    const { data } = await db.from('revenue_type_methods').select('revenue_account_id, method')
      .eq('org_id', args.orgId).eq('location_id', args.locationId).eq('revenue_account_id', revenueAccountId).maybeSingle();
    const r = data as { revenue_account_id: string; method: RevRecMethod } | null;
    if (r?.method) revenueTypeMap.set(revenueAccountId, r.method);
  }

  const jobTypeMap = new Map<string, RevRecMethod>();
  const typeKey = job.job_type ?? job.archetype ?? null;
  if (typeKey) {
    const { data } = await db.from('rev_rec_method_map').select('job_type, method')
      .eq('org_id', args.orgId).eq('location_id', args.locationId).eq('job_type', typeKey).maybeSingle();
    const m = data as { job_type: string; method: RevRecMethod } | null;
    if (m?.method) jobTypeMap.set(typeKey, m.method);
  }

  const { data: loc } = await db.schema('core').from('locations').select('rev_rec_method').eq('id', args.locationId).maybeSingle();
  const companyDefault = (loc as { rev_rec_method: RevRecMethod | null } | null)?.rev_rec_method ?? DEFAULT_REV_REC_METHOD;

  return resolveRevRecMethod({ ...job, revenue_account_id: revenueAccountId }, jobTypeMap, companyDefault, revenueTypeMap);
}
