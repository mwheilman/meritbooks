/**
 * Revenue recognition engine (Books-owned, method-driven, resolved PER JOB).
 *
 * Contract v3 §1: method resolves in order
 *   1. per-job override  (core.jobs.rev_rec_method_override)
 *   2. company job_type -> method map  (rev_rec_method_map)
 *   3. company default  (core.locations.rev_rec_method)
 * The resolved method — never the presence/absence of pct_complete — governs
 * whether JOB_PROGRESS inputs are consumed. Recognition reads only core data and
 * never a proj_ table, so it works standalone.
 *
 * Recognition posts the incremental earned amount for the period:
 *   CR Revenue (delta); DR Deferred Revenue (relieve billings-in-excess) and/or
 *   DR Unbilled Receivable / Contract Asset (earned beyond billed).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from './gl-posting';

type DB = SupabaseClient;

export type RevRecMethod =
  | 'PCT_COSTS_INCURRED' | 'PCT_COMPLETE' | 'COMPLETED_CONTRACT' | 'POINT_OF_SALE'
  | 'MILESTONE' | 'AS_BILLED' | 'RATABLY' | 'SUBSCRIPTION' | 'CASH';

const DEFERRED_ACCT = '2410';      // Deferred Revenue (billings in excess)
const UNBILLED_ACCT = '1180';      // Unbilled Receivable (contract asset)

export interface JobRevRecRow {
  id: string;
  location_id: string;
  job_type: string | null;
  archetype: string | null;
  status: string | null;
  rev_rec_method: RevRecMethod | null;
  rev_rec_method_override: RevRecMethod | null;
  revenue_account_id: string | null;
  contract_amount_cents: number | null;
  estimated_cost_cents: number | null;
  actual_cost_cents: number | null;
  billed_to_date_cents: number | null;
  pct_complete: number | null;          // stored 0..100
  revenue_recognized_cents: number | null;
  service_start_date: string | null;
  service_end_date: string | null;
}

/**
 * Resolve the recognition method for one job:
 *   1. per-job override
 *   2. per-revenue-type method (the job's revenue_account_id)  ← primary selection
 *   3. legacy job_type → method map
 *   4. company default
 */
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

/** Load the per-revenue-type method map for a company. */
async function loadRevenueTypeMap(db: DB, orgId: string, locationId: string): Promise<Map<string, RevRecMethod>> {
  const { data } = await db.from('revenue_type_methods').select('revenue_account_id, method').eq('org_id', orgId).eq('location_id', locationId);
  return new Map((data ?? []).map((r) => [(r as { revenue_account_id: string }).revenue_account_id, (r as { method: RevRecMethod }).method]));
}

/**
 * Earned-revenue-to-date for the resolved method.
 * Returns the cumulative revenue that should be recognized through `asOf`,
 * plus the fraction (0..1) for audit. `collectedToDate` is only used by CASH.
 */
export function earnedToDate(
  method: RevRecMethod,
  job: JobRevRecRow,
  asOf: string,
  collectedToDateCents: number,
): { earnedCents: number; fraction: number } {
  const contract = Number(job.contract_amount_cents ?? 0);
  const estimate = Number(job.estimated_cost_cents ?? 0);
  const actual = Number(job.actual_cost_cents ?? 0);
  const billed = Number(job.billed_to_date_cents ?? 0);
  const done = job.status === 'COMPLETE' || job.status === 'CLOSED';

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  switch (method) {
    case 'PCT_COSTS_INCURRED': {
      const f = estimate > 0 ? clamp01(actual / estimate) : 0;
      return { earnedCents: Math.round(contract * f), fraction: f };
    }
    case 'PCT_COMPLETE': {
      const f = clamp01(Number(job.pct_complete ?? 0) / 100);
      return { earnedCents: Math.round(contract * f), fraction: f };
    }
    case 'COMPLETED_CONTRACT':
      return { earnedCents: done ? contract : 0, fraction: done ? 1 : 0 };
    case 'RATABLY':
    case 'SUBSCRIPTION': {
      if (job.service_start_date && job.service_end_date) {
        const s = new Date(`${job.service_start_date}T00:00:00Z`).getTime();
        const e = new Date(`${job.service_end_date}T00:00:00Z`).getTime();
        const now = new Date(`${asOf}T00:00:00Z`).getTime();
        const f = e > s ? clamp01((now - s) / (e - s)) : (now >= e ? 1 : 0);
        return { earnedCents: Math.round(contract * f), fraction: f };
      }
      return { earnedCents: billed, fraction: contract > 0 ? clamp01(billed / contract) : 0 };
    }
    case 'POINT_OF_SALE':
    case 'MILESTONE':
    case 'AS_BILLED':
      // Point-in-time / billing-based: revenue follows what's been billed.
      return { earnedCents: billed, fraction: contract > 0 ? clamp01(billed / contract) : 0 };
    case 'CASH':
      return { earnedCents: collectedToDateCents, fraction: contract > 0 ? clamp01(collectedToDateCents / contract) : 0 };
    default:
      return { earnedCents: 0, fraction: 0 };
  }
}

async function acctByNumber(db: DB, orgId: string, number: string): Promise<string | null> {
  const { data } = await db.from('accounts').select('id').eq('org_id', orgId).eq('account_number', number).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function revenueAccount(db: DB, orgId: string): Promise<string | null> {
  const { data } = await db.from('accounts').select('id, name').eq('org_id', orgId).eq('account_type', 'REVENUE').eq('is_active', true).order('account_number', { ascending: true });
  const rows = (data ?? []) as { id: string; name: string }[];
  if (rows.length === 0) return null;
  const preferred = rows.find((r) => /service|sales|contract|operating|revenue/i.test(r.name));
  return (preferred ?? rows[0]).id;
}

/** Current deferred-revenue balance attributable to a job (credits − debits on 2410). */
async function jobDeferredBalance(db: DB, orgId: string, jobId: string, deferredAcctId: string): Promise<number> {
  const { data } = await db
    .from('gl_entry_lines')
    .select('debit_cents, credit_cents')
    .eq('org_id', orgId)
    .eq('account_id', deferredAcctId)
    .eq('job_id', jobId);
  let bal = 0;
  for (const l of (data ?? []) as { debit_cents: number; credit_cents: number }[]) {
    bal += Number(l.credit_cents ?? 0) - Number(l.debit_cents ?? 0);
  }
  return bal;
}

/** Cash collected to date for a job (sum of invoice payments). */
async function jobCollected(db: DB, orgId: string, jobId: string): Promise<number> {
  const { data } = await db.from('invoices').select('amount_paid_cents').eq('org_id', orgId).eq('job_id', jobId);
  return (data ?? []).reduce((s: number, r: { amount_paid_cents: number }) => s + Number(r.amount_paid_cents ?? 0), 0);
}

export interface RecognizeOneResult {
  jobId: string;
  method: RevRecMethod;
  earnedToDateCents: number;
  priorRecognizedCents: number;
  deltaCents: number;
  status: 'posted' | 'unchanged' | 'skipped';
  entryNumber?: string;
  reason?: string;
}

/** Recognize a single job through `asOf`. Posts the incremental entry if any. Preview = no posting. */
export async function recognizeJob(
  db: DB,
  orgId: string,
  job: JobRevRecRow,
  method: RevRecMethod,
  asOf: string,
  runBy: string | null,
  opts: { preview?: boolean } = {},
): Promise<RecognizeOneResult> {
  const collected = method === 'CASH' ? await jobCollected(db, orgId, job.id) : 0;
  const { earnedCents, fraction } = earnedToDate(method, job, asOf, collected);
  const prior = Number(job.revenue_recognized_cents ?? 0);
  const delta = earnedCents - prior;

  const base: RecognizeOneResult = {
    jobId: job.id, method, earnedToDateCents: earnedCents, priorRecognizedCents: prior, deltaCents: delta,
    status: 'unchanged',
  };
  if (delta === 0) return base;
  if (opts.preview) return { ...base, status: 'posted' }; // preview reports what *would* post

  const revenueId = await revenueAccount(db, orgId);
  const deferredId = await acctByNumber(db, orgId, DEFERRED_ACCT);
  const unbilledId = await acctByNumber(db, orgId, UNBILLED_ACCT);
  if (!revenueId || !deferredId || !unbilledId) {
    return { ...base, status: 'skipped', reason: 'Missing revenue / deferred (2410) / unbilled (1180) account' };
  }

  const lines: { account_id: string; debit_cents: number; credit_cents: number; location_id: string; job_id: string; memo: string }[] = [];

  if (delta > 0) {
    const deferredAvail = Math.max(0, await jobDeferredBalance(db, orgId, job.id, deferredId));
    const relieve = Math.min(delta, deferredAvail);
    const unbilled = delta - relieve;
    if (relieve > 0) lines.push({ account_id: deferredId, debit_cents: relieve, credit_cents: 0, location_id: job.location_id, job_id: job.id, memo: 'Relieve deferred revenue' });
    if (unbilled > 0) lines.push({ account_id: unbilledId, debit_cents: unbilled, credit_cents: 0, location_id: job.location_id, job_id: job.id, memo: 'Unbilled receivable (contract asset)' });
    lines.push({ account_id: revenueId, debit_cents: 0, credit_cents: delta, location_id: job.location_id, job_id: job.id, memo: 'Recognized revenue' });
  } else {
    const amt = Math.abs(delta);
    lines.push({ account_id: revenueId, debit_cents: amt, credit_cents: 0, location_id: job.location_id, job_id: job.id, memo: 'Reverse over-recognized revenue' });
    lines.push({ account_id: unbilledId, debit_cents: 0, credit_cents: amt, location_id: job.location_id, job_id: job.id, memo: 'Reduce contract asset' });
  }

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: job.location_id,
    entry_date: asOf,
    entry_type: 'STANDARD',
    memo: `Revenue recognition (${method})`,
    source_module: 'REV_REC',
    source_id: job.id,
    // created_by is a uuid column; Clerk actor IDs are text and don't cast (see
    // migration 018). Record the human actor in revenue_recognition_runs.run_by
    // (text) below; the GL author follows the app-wide null-attribution pattern.
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) {
    return { ...base, status: 'skipped', reason: je.error ?? 'Posting failed' };
  }

  await db.schema('core').from('jobs').update({
    revenue_recognized_cents: earnedCents,
    rev_rec_method: method,           // sync resolved method for display
    rev_rec_last_run_on: asOf,
    updated_at: new Date().toISOString(),
  }).eq('id', job.id);

  await db.from('revenue_recognition_runs').insert({
    org_id: orgId, location_id: job.location_id, job_id: job.id, as_of_date: asOf, method,
    contract_value_cents: Number(job.contract_amount_cents ?? 0),
    cost_estimate_cents: Number(job.estimated_cost_cents ?? 0),
    actual_cost_cents: Number(job.actual_cost_cents ?? 0),
    pct_recognized: Math.round(fraction * 10000) / 10000,
    earned_to_date_cents: earnedCents, prior_recognized_cents: prior, recognized_delta_cents: delta,
    gl_entry_id: je.entry_id, run_by: runBy,
  });

  return { ...base, status: 'posted', entryNumber: je.entry_number };
}

const JOB_SELECT =
  'id, location_id, job_type, archetype, status, rev_rec_method, rev_rec_method_override, revenue_account_id, ' +
  'contract_amount_cents, estimated_cost_cents, actual_cost_cents, billed_to_date_cents, ' +
  'pct_complete, revenue_recognized_cents, service_start_date, service_end_date';

/** Resolve + recognize a single job by id through `asOf` (used by the JOB_PROGRESS consumer). */
export async function recognizeJobById(
  db: DB,
  orgId: string,
  jobId: string,
  asOf: string,
  runBy: string | null,
): Promise<RecognizeOneResult> {
  const { data: job } = await db.schema('core').from('jobs').select(JOB_SELECT).eq('org_id', orgId).eq('id', jobId).maybeSingle();
  if (!job) return { jobId, method: 'PCT_COSTS_INCURRED', earnedToDateCents: 0, priorRecognizedCents: 0, deltaCents: 0, status: 'skipped', reason: 'Job not found' };
  const j = job as unknown as JobRevRecRow & { id: string };
  const { data: loc } = await db.schema('core').from('locations').select('rev_rec_method').eq('id', j.location_id).maybeSingle();
  const companyDefault = ((loc as { rev_rec_method: RevRecMethod } | null)?.rev_rec_method ?? 'PCT_COSTS_INCURRED');
  const map = await loadMethodMap(db, orgId, j.location_id);
  const revenueTypeMap = await loadRevenueTypeMap(db, orgId, j.location_id);
  const method = resolveRevRecMethod(j, map, companyDefault, revenueTypeMap);
  return recognizeJob(db, orgId, j, method, asOf, runBy);
}

/** Load the job_type→method map for a company. */
async function loadMethodMap(db: DB, orgId: string, locationId: string): Promise<Map<string, RevRecMethod>> {
  const { data } = await db.from('rev_rec_method_map').select('job_type, method').eq('org_id', orgId).eq('location_id', locationId);
  return new Map((data ?? []).map((r) => [(r as { job_type: string }).job_type, (r as { method: RevRecMethod }).method]));
}

export interface RecognizeRunResult {
  asOf: string;
  posted: number;
  unchanged: number;
  skipped: number;
  totalRecognizedDeltaCents: number;
  jobs: (RecognizeOneResult & { jobNumber?: string; jobName?: string })[];
}

/** Recognize all eligible jobs (optionally one company) through `asOf`. preview = compute, don't post. */
export async function recognizeRun(
  db: DB,
  orgId: string,
  args: { locationId?: string | null; asOf: string; runBy: string | null; preview?: boolean },
): Promise<RecognizeRunResult> {
  let q = db.schema('core').from('jobs').select(JOB_SELECT)
    .eq('org_id', orgId)
    .in('status', ['ACTIVE', 'COMPLETE', 'ON_HOLD']);
  if (args.locationId) q = q.eq('location_id', args.locationId);
  const { data: jobs } = await q;

  // Company defaults + per-company method maps (cache by location).
  const locIds = [...new Set((jobs ?? []).map((j) => (j as unknown as JobRevRecRow).location_id))];
  const defaultByLoc = new Map<string, RevRecMethod>();
  const mapByLoc = new Map<string, Map<string, RevRecMethod>>();
  const revTypeByLoc = new Map<string, Map<string, RevRecMethod>>();
  for (const lid of locIds) {
    const { data: loc } = await db.schema('core').from('locations').select('rev_rec_method').eq('id', lid).maybeSingle();
    defaultByLoc.set(lid, ((loc as { rev_rec_method: RevRecMethod } | null)?.rev_rec_method ?? 'PCT_COSTS_INCURRED'));
    mapByLoc.set(lid, await loadMethodMap(db, orgId, lid));
    revTypeByLoc.set(lid, await loadRevenueTypeMap(db, orgId, lid));
  }

  const out: RecognizeRunResult = { asOf: args.asOf, posted: 0, unchanged: 0, skipped: 0, totalRecognizedDeltaCents: 0, jobs: [] };

  for (const raw of (jobs ?? []) as unknown as (JobRevRecRow & { id: string })[]) {
    const method = resolveRevRecMethod(raw, mapByLoc.get(raw.location_id) ?? new Map(), defaultByLoc.get(raw.location_id) ?? 'PCT_COSTS_INCURRED', revTypeByLoc.get(raw.location_id));
    const r = await recognizeJob(db, orgId, raw, method, args.asOf, args.runBy, { preview: args.preview });
    if (r.status === 'posted') { out.posted++; out.totalRecognizedDeltaCents += r.deltaCents; }
    else if (r.status === 'unchanged') out.unchanged++;
    else out.skipped++;
    out.jobs.push(r);
  }

  // Enrich with job number/name for display.
  if (out.jobs.length > 0) {
    const ids = out.jobs.map((j) => j.jobId);
    const { data: meta } = await db.schema('core').from('jobs').select('id, job_number, name').in('id', ids);
    const m = new Map((meta ?? []).map((x) => [(x as { id: string }).id, x as { job_number: string; name: string }]));
    out.jobs = out.jobs.map((j) => ({ ...j, jobNumber: m.get(j.jobId)?.job_number, jobName: m.get(j.jobId)?.name }));
  }

  return out;
}
