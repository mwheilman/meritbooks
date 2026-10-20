import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Scope } from '@/lib/scope';
import { listAllProjects } from './projects';
import { listAllChangeOrders } from './work';
import type { ChangeOrderRow, ProjectListRow } from './types';

export interface ScopedJobs {
  byId: Map<string, ProjectListRow>;
  label: (jobId: string) => string | null;
  company: (jobId: string) => string | null;
}

/** Jobs in the current scope, for filtering org-wide rows (tasks, change orders) to it. */
export async function scopedJobs(db: SupabaseClient, scope: Scope): Promise<ScopedJobs> {
  const { rows } = await listAllProjects(db, scope.companyIds, 2000);
  const byId = new Map(rows.map((r) => [r.job_id, r]));
  const names = new Map(scope.tenant.companies.map((c) => [c.id, c.name]));
  const multi = scope.companyIds.length > 1;
  return {
    byId,
    label: (id) => {
      const j = byId.get(id);
      return j ? [j.job_number, j.name].filter(Boolean).join(' · ') : null;
    },
    company: (id) => (multi ? names.get(byId.get(id)?.location_id ?? '') ?? null : null),
  };
}

export async function scopedChangeOrders(db: SupabaseClient, scope: Scope, openOnly: boolean) {
  const [jobs, cos] = await Promise.all([scopedJobs(db, scope), listAllChangeOrders(db, { openOnly, limit: 1000 })]);
  return cos
    .filter((c: ChangeOrderRow) => jobs.byId.has(c.job_id))
    .map((c) => ({ ...c, jobLabel: jobs.label(c.job_id), company: jobs.company(c.job_id) }));
}
