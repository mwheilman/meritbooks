/**
 * A4 (migration 194): rev-rec inputs AS OF a date, from the books.
 *
 * core.jobs.actual_cost_cents / billed_to_date_cents were never maintained after creation, so
 * PCT_COSTS_INCURRED recognized 0 and MILESTONE / AS_BILLED never relieved Deferred Revenue. The
 * one source now is public.job_inputs_as_of (SQL, security invoker):
 *   actual cost = opening + Σ posted job-tagged COGS / OPEX lines ≤ as-of (WIP / rev-rec entries excluded)
 *   billed      = opening + Σ posted invoice subtotals ≤ as-of (deposits + retainage releases excluded)
 *   contract / estimate / % complete = the newest pinned JOB_PROGRESS snapshot ≤ as-of, else the job
 * Every recognizer (the JOB_PROGRESS interim path and the month-end WIP engine) overlays these on
 * the job row before calling the pure method math (earned.ts / wip-engine.ts) — one path.
 *
 * Degrade-safe: when the function is not deployed yet (PGRST202 / 42883) the job columns are used
 * unchanged and `source` says so; any other error is raised.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobRevRecRow } from '@/lib/services/rev-rec';

type DB = SupabaseClient;

export interface JobInputsAsOf {
  jobId: string;
  openingCostCents: number;
  glCostCents: number;
  actualCostCents: number;
  openingBilledCents: number;
  invoicedCents: number;
  billedToDateCents: number;
  contractValueCents: number | null;
  costEstimateCents: number | null;
  /** 0..100, like core.jobs.pct_complete. */
  pctComplete: number | null;
  snapshotVersion: number | null;
}

export type InputsSource = 'BOOKS_AS_OF' | 'JOB_COLUMNS';

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const nn = (v: unknown): number | null => (v == null ? null : n(v));

function missingFunction(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === 'PGRST202' || err.code === '42883' || /could not find the function|function .* does not exist/i.test(err.message ?? '');
}

export async function loadJobInputsAsOf(
  db: DB,
  orgId: string,
  jobIds: string[],
  asOf: string,
): Promise<{ source: InputsSource; byJob: Map<string, JobInputsAsOf> }> {
  const byJob = new Map<string, JobInputsAsOf>();
  if (jobIds.length === 0) return { source: 'BOOKS_AS_OF', byJob };
  if (typeof (db as { rpc?: unknown }).rpc !== 'function') return { source: 'JOB_COLUMNS', byJob };
  for (let i = 0; i < jobIds.length; i += 500) {
    const chunk = jobIds.slice(i, i + 500);
    const { data, error } = await db.rpc('job_inputs_as_of', { p_org: orgId, p_job_ids: chunk, p_as_of: asOf });
    if (error) {
      if (missingFunction(error)) {
        console.warn('[rev-rec] job_inputs_as_of is not deployed — using job columns (apply migration 194)');
        return { source: 'JOB_COLUMNS', byJob: new Map() };
      }
      throw new Error(`Could not read job inputs as of ${asOf}: ${error.message}`);
    }
    if (data == null) return { source: 'JOB_COLUMNS', byJob: new Map() };
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const id = String(r.job_id);
      byJob.set(id, {
        jobId: id,
        openingCostCents: n(r.opening_cost_cents),
        glCostCents: n(r.gl_cost_cents),
        actualCostCents: n(r.actual_cost_cents),
        openingBilledCents: n(r.opening_billed_cents),
        invoicedCents: n(r.invoiced_cents),
        billedToDateCents: n(r.billed_to_date_cents),
        contractValueCents: nn(r.contract_value_cents),
        costEstimateCents: nn(r.cost_estimate_cents),
        pctComplete: nn(r.pct_complete),
        snapshotVersion: r.snapshot_version == null ? null : n(r.snapshot_version),
      });
    }
  }
  return { source: 'BOOKS_AS_OF', byJob };
}

/** Overlay the as-of inputs on a job row (a copy) — what every recognizer computes from. */
export function withInputsAsOf<T extends JobRevRecRow>(job: T, inputs: JobInputsAsOf | undefined): T {
  if (!inputs) return job;
  return {
    ...job,
    actual_cost_cents: inputs.actualCostCents,
    billed_to_date_cents: inputs.billedToDateCents,
    contract_amount_cents: inputs.contractValueCents ?? job.contract_amount_cents,
    estimated_cost_cents: inputs.costEstimateCents ?? job.estimated_cost_cents,
    pct_complete: inputs.pctComplete ?? job.pct_complete,
  };
}
