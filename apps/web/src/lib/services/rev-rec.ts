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
 *
 * ONE MONTH-END MECHANISM (FPB-rev-rec-wip §4). `earnedToDate` here is the method
 * authority for every recognizer. The month-end recognition step is the canonical WIP
 * engine (lib/rev-rec/wip-engine.ts): a permanent billings reclass + a self-reversing
 * over/under (1180/2410) + loss-provision adjustment, adjust-to-target on GL balances.
 * The old standalone 1180 accrual and the batch `recognizeRun` are retired. The
 * per-job `recognizeJob` below remains only for the JOB_PROGRESS event path; any
 * interim posting it makes is swept and trued up at month end, so nothing double counts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from './gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { scopedWriter } from '@/lib/db/scoped-writer';
import { earnedToDate } from '@/lib/rev-rec/earned';

type DB = SupabaseClient;

export type RevRecMethod =
  | 'PCT_COSTS_INCURRED' | 'PCT_COMPLETE' | 'COMPLETED_CONTRACT' | 'POINT_OF_SALE'
  | 'MILESTONE' | 'AS_BILLED' | 'RATABLY' | 'SUBSCRIPTION' | 'CASH';

// Deferred Revenue (billings in excess) and Unbilled Receivable (contract asset)
// are resolved by ROLE — DEFERRED_REVENUE / UNBILLED_RECEIVABLE — never by a
// hard-coded account number, so a tenant that remaps 2410/1180 on the Account
// Roles screen is honored (Rule 11 / posting-engine contract). The role registry's
// standard-COA fallback is still 2410 / 1180 (see account-roles.ROLE_DEFAULT_NUMBER).

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
  /** MILESTONE: milestones defined / accepted on the contract (optional). */
  total_milestones?: number | null;
  completed_milestones?: number | null;
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

// Earned-revenue-to-date per method lives in the PURE module lib/rev-rec/earned.ts (so
// the WIP engine and the election card's worked examples share it without server code).
export { earnedToDate };

async function revenueAccount(db: DB, orgId: string): Promise<string | null> {
  const { data } = await db.from('accounts').select('id, name').eq('org_id', orgId).eq('account_type', 'REVENUE').eq('is_active', true).order('account_number', { ascending: true });
  const rows = (data ?? []) as { id: string; name: string }[];
  if (rows.length === 0) return null;
  const preferred = rows.find((r) => /service|sales|contract|operating|revenue/i.test(r.name));
  return (preferred ?? rows[0]).id;
}

/** Current deferred-revenue balance attributable to a job (credits − debits on 2410). */
async function jobDeferredBalance(db: DB, orgId: string, jobId: string, deferredAcctId: string): Promise<number> {
  // Paged — this balance caps the recognition delta that gets POSTED, so a
  // 1,000-row-truncated read would corrupt the posting.
  const { data } = await fetchAll(
    () =>
      db
        .from('gl_entry_lines')
        .select('debit_cents, credit_cents')
        .eq('org_id', orgId)
        .eq('account_id', deferredAcctId)
        .eq('job_id', jobId),
    { label: 'rev-rec job deferred gl_entry_lines' },
  );
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

/**
 * Stable per-job+period idempotency key for a recognition entry. Recognition is a
 * once-per-period (month-end) event: one recognition JE per job per calendar month.
 * Migration 064's UNIQUE (org_id, source_ref, entry_type) makes the DB the
 * double-post guarantor — two concurrent recognition runs that both read the same
 * `prior` can no longer both post; the loser fails on insert. (Mirrors the
 * unbilled-accrual service's `unbilled_accrual:<job>:<period>` scheme.)
 */
export function revRecSourceRef(jobId: string, asOf: string): string {
  return `rev_rec:${jobId}:${asOf.slice(0, 7)}`;
}

/** True if a POSTED recognition JE already exists for this job+period source_ref. */
async function recognitionAlreadyPosted(db: DB, orgId: string, sourceRef: string): Promise<boolean> {
  const { data } = await db
    .from('gl_entries')
    .select('id')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .eq('status', 'POSTED')
    .limit(1)
    .maybeSingle();
  return !!(data as { id: string } | null);
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

  // Resolve the balance-sheet offsets by ROLE (honors a tenant's 2410/1180 remap),
  // and the revenue account the same way the billing paths do — prefer the job's own
  // revenue stream, else the first suitable REVENUE account.
  let deferredId: string;
  let unbilledId: string;
  try {
    deferredId = (await resolveRole(db, orgId, 'DEFERRED_REVENUE')).id;
    unbilledId = (await resolveRole(db, orgId, 'UNBILLED_RECEIVABLE')).id;
  } catch (e) {
    return {
      ...base,
      status: 'skipped',
      reason: e instanceof PostingError ? e.message : 'Cannot resolve deferred-revenue / unbilled-receivable roles',
    };
  }
  const revenueId = job.revenue_account_id ?? (await revenueAccount(db, orgId));
  if (!revenueId) {
    return { ...base, status: 'skipped', reason: 'No revenue account to credit — set the job revenue account or seed a REVENUE account' };
  }

  // Idempotency: one recognition JE per job+period. The pre-check reports gracefully;
  // migration 064's UNIQUE(org_id, source_ref, entry_type) is the hard race guarantor.
  const sourceRef = revRecSourceRef(job.id, asOf);
  if (await recognitionAlreadyPosted(db, orgId, sourceRef)) {
    return { ...base, status: 'skipped', reason: `Revenue already recognized for ${asOf.slice(0, 7)} (${sourceRef})` };
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
    // Per-job+period idempotency key. Migration 064's UNIQUE(org_id, source_ref,
    // entry_type) is the DB double-post guarantor against concurrent recognition runs.
    source_ref: sourceRef,
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

  // revenue_recognition_runs is SELECT-only for members (migration 172): the job's client was
  // asserted in the caller's org + scope (postJournalEntry above posts to it), then the
  // service role writes the run row with the org pinned.
  const runWriter = await scopedWriter(db, orgId, [job.location_id]);
  await runWriter.from('revenue_recognition_runs').insert({
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
  'pct_complete, revenue_recognized_cents, service_start_date, service_end_date, total_milestones, completed_milestones';

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

// The month-end batch run (`recognizeRun`) is RETIRED (FPB-rev-rec-wip §4): the ONE
// canonical month-end recognizer is the WIP engine (lib/rev-rec/wip-engine.ts +
// wip-run-service.ts). recognizeJob / recognizeJobById stay for the Projects-seam
// JOB_PROGRESS consumer (interim recognition on a progress event); the month-end WIP
// reclass + adjustment trues those postings up by construction.
