import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { loadJob, type JobRef } from '@/lib/pm/guarded';
import { one, pm } from '@/lib/pm/db';
import { jobTypeModules } from '@/lib/pm/modules';
import type { ModuleKey } from '@/lib/packs';
import { billingModesFor, type BillingUiMode } from './billing-modes';

export interface MoneyJob extends JobRef {
  modules: Set<ModuleKey>;
  billingModes: string[];
  defaultBillingMode: string | null;
}

/** The job as RLS sees it, with its job type's modules and billing modes (404 when absent). */
export async function loadMoneyJob(db: SupabaseClient, jobId: string): Promise<MoneyJob> {
  const job = await loadJob(db, jobId);
  const p = one<{ job_type_id: string }>(await pm(db).from('projects').select('job_type_id').eq('job_id', job.job_id).maybeSingle(), 'project');
  const jt = p
    ? one<{ modules: Record<string, boolean>; billing_modes: string[]; default_billing_mode: string }>(
        await pm(db).from('job_types').select('modules, billing_modes, default_billing_mode').eq('id', p.job_type_id).maybeSingle(),
        'job type',
      )
    : null;
  return { ...job, modules: jobTypeModules(jt?.modules ?? {}), billingModes: jt?.billing_modes ?? [], defaultBillingMode: jt?.default_billing_mode ?? null };
}

/** 422 unless the job type offers this billing mode (the UI hides it; the route re-checks). */
export function assertMode(job: MoneyJob, mode: BillingUiMode): void {
  const { modes } = billingModesFor({ billingModes: job.billingModes, defaultBillingMode: job.defaultBillingMode, modules: job.modules });
  if (!modes.includes(mode)) {
    throw new HttpError(422, 'This job type does not bill that way. Change its billing modes in Settings.', 'BILLING_MODE_NOT_ALLOWED');
  }
}

/** 422 unless the job type uses the module. */
export function assertModule(job: MoneyJob, m: ModuleKey, label: string): void {
  if (!job.modules.has(m)) throw new HttpError(422, `This job type does not use ${label}. Turn it on in Settings.`, 'MODULE_OFF');
}
