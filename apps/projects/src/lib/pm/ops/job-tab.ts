import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModuleKey } from '@/lib/packs';
import { one } from '@/lib/pm/db';
import type { Vocabulary } from '@/lib/pm/vocab';
import type { JobOption } from './scope';

/** The props every job-tab panel in components/ops/job-tabs takes (see REGISTRATION.md). */
export interface JobTabProps {
  jobId: string;
  companyId: string;
  modules: ReadonlySet<ModuleKey> | ReadonlyArray<ModuleKey>;
  vocabulary: Vocabulary;
}

export function hasModule(modules: JobTabProps['modules'], m: ModuleKey): boolean {
  return Array.isArray(modules) ? (modules as ReadonlyArray<ModuleKey>).includes(m) : (modules as ReadonlySet<ModuleKey>).has(m);
}

/** The one job as a JobOption (label, customer, company) for the shared ops components. */
export async function jobOption(db: SupabaseClient, jobId: string): Promise<JobOption | null> {
  const j = one<{ job_id: string; location_id: string; job_number: string | null; name: string; customer_id: string | null; customer_name: string | null; stage_is_terminal: boolean | null; job_type_key: string }>(
    await db.schema('pm').from('v_project_list').select('job_id, location_id, job_number, name, customer_id, customer_name, stage_is_terminal, job_type_key').eq('job_id', jobId).maybeSingle(),
    'job',
  );
  if (!j) return null;
  return {
    id: j.job_id, label: [j.job_number, j.name].filter(Boolean).join(' · '), companyId: j.location_id, company: null, customerId: j.customer_id,
    customer: j.customer_name, open: !j.stage_is_terminal, jobTypeKey: j.job_type_key,
  };
}

/** The company's primary pack key (labels and create defaults). */
export async function packKeyOf(db: SupabaseClient, companyId: string): Promise<string | null> {
  const r = await db.schema('pm').from('pack_installs').select('pack_key').eq('location_id', companyId).eq('role', 'primary').eq('status', 'ACTIVE').maybeSingle();
  return (r.data as { pack_key: string } | null)?.pack_key ?? null;
}
