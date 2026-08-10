/**
 * Unbilled-revenue accrual RUN (I/O orchestration on top of the pure helper).
 *
 * Composes:
 *   • lib/jobcost/wip.ts            → earned revenue & under-billing per job (POC)
 *   • lib/rev-rec/unbilled-accrual  → the pure adjust-to-target plan + balanced lines
 *   • lib/posting/account-roles     → resolve UNBILLED_RECEIVABLE (1180) + Revenue
 *   • lib/services/gl-posting       → post the balanced JE (DB enforces balance)
 *
 * Preview (preview:true) computes and reports WITHOUT posting. Posting is idempotent
 * per job+period via a stable source_ref (`unbilled_accrual:<jobId>:<YYYY-MM>`), which
 * migration 064's UNIQUE (org_id, source_ref, entry_type) makes the DB guarantor for —
 * a second post of the same job+period fails on insert rather than double-booking.
 *
 * TIE-OUT: after a run, the contract-asset (1180) balance attributable to a job equals
 * its WIP under-billing (target), because we post only the delta target − existing.
 * The run returns the portfolio numbers so the UI can show the tie.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeWipJob } from '@/lib/jobcost/wip';
import { resolveRole, type AccountRef } from '@/lib/posting/account-roles';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { planUnbilledAccrual, buildUnbilledAccrualLines } from './unbilled-accrual';

type DB = SupabaseClient;

/** source_module tag identifying JEs produced by THIS mechanism. */
export const ACCRUAL_SOURCE_MODULE = 'REV_REC_ACCRUAL';

const JOB_SELECT =
  'id, job_number, name, location_id, status, contract_amount_cents, ' +
  'estimated_cost_cents, actual_cost_cents, billed_to_date_cents, pct_complete, revenue_account_id';

interface JobRow {
  id: string;
  job_number: string | null;
  name: string | null;
  location_id: string;
  status: string | null;
  contract_amount_cents: number | null;
  estimated_cost_cents: number | null;
  actual_cost_cents: number | null;
  billed_to_date_cents: number | null;
  pct_complete: number | null; // stored 0..100
  revenue_account_id: string | null;
}

export type AccrualStatus =
  | 'proposed' // preview: a delta would post
  | 'accrued' // posted DR 1180 / CR Revenue
  | 'reversed' // posted DR Revenue / CR 1180 (billing caught up)
  | 'already_accrued' // an accrual JE already exists for this job+period
  | 'balanced' // 1180 already ties to WIP — nothing to do
  | 'skipped'; // could not resolve accounts / post failed

export interface AccrualJobResult {
  jobId: string;
  jobNumber: string | null;
  jobName: string | null;
  locationId: string;
  earnedRevenueCents: number;
  billedToDateCents: number;
  /** WIP under-billing (earned − billed, floored at 0) = target 1180 balance. */
  underBillingCents: number;
  /** Contract asset already carried on 1180 for this job (all sources). */
  existingContractAssetCents: number;
  /** target − existing (signed): >0 accrue, <0 reverse, 0 tied. */
  deltaCents: number;
  action: 'ACCRUE' | 'REVERSE' | 'NONE';
  status: AccrualStatus;
  entryNumber?: string;
  reason?: string;
}

export interface AccrualRunResult {
  asOf: string;
  period: string; // YYYY-MM
  preview: boolean;
  unbilledAccount: { number: string; name: string } | null;
  /** Jobs that are underbilled (earned > billed). */
  underbilledJobs: number;
  /** Jobs with a non-zero delta to post (accrue or reverse). */
  jobsToPost: number;
  /** Sum of targets (net WIP under-billing) across shown jobs, cents. */
  totalUnderBillingCents: number;
  /** Sum of contract asset already carried on 1180 for shown jobs, cents. */
  existingContractAssetCents: number;
  /** Sum of deltas to post, cents (signed). */
  proposedDeltaCents: number;
  /** existing + delta — the 1180 balance AFTER the run (ties to total target). */
  projectedContractAssetCents: number;
  posted: number;
  reversed: number;
  skipped: number;
  jobs: AccrualJobResult[];
}

/** Prefer the job's own revenue stream; else the first suitable REVENUE account. */
async function loadFallbackRevenueAccount(db: DB, orgId: string): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('account_type', 'REVENUE')
    .eq('is_active', true)
    .order('account_number', { ascending: true });
  const rows = (data ?? []) as { id: string; name: string }[];
  if (rows.length === 0) return null;
  const preferred = rows.find((r) => /service|sales|contract|operating|revenue/i.test(r.name));
  return (preferred ?? rows[0]).id;
}

/** Net contract-asset (1180) balance per job (POSTED, entry_date <= asOf), debit-positive. */
async function loadContractAssetByJob(
  db: DB,
  orgId: string,
  unbilledAccountId: string,
  jobIds: string[],
  asOf: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (jobIds.length === 0) return out;
  const { data } = await db
    .from('gl_entry_lines')
    .select('debit_cents, credit_cents, job_id, gl_entries!inner(entry_date, status)')
    .eq('org_id', orgId)
    .eq('account_id', unbilledAccountId)
    .in('job_id', jobIds)
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', asOf);
  for (const l of (data ?? []) as Array<{ debit_cents: number | null; credit_cents: number | null; job_id: string | null }>) {
    if (!l.job_id) continue;
    const bal = (out.get(l.job_id) ?? 0) + Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0);
    out.set(l.job_id, bal);
  }
  return out;
}

/** Which of these job+period source_refs already have a POSTED accrual JE. */
async function loadExistingAccrualRefs(db: DB, orgId: string, refs: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (refs.length === 0) return out;
  const { data } = await db
    .from('gl_entries')
    .select('source_ref')
    .eq('org_id', orgId)
    .eq('status', 'POSTED')
    .in('source_ref', refs);
  for (const r of (data ?? []) as { source_ref: string | null }[]) {
    if (r.source_ref) out.add(r.source_ref);
  }
  return out;
}

function periodOf(asOf: string): string {
  return asOf.slice(0, 7);
}

function accrualSourceRef(jobId: string, period: string): string {
  return `unbilled_accrual:${jobId}:${period}`;
}

export interface RunUnbilledAccrualArgs {
  locationId?: string | null;
  asOf: string; // YYYY-MM-DD
  runBy: string | null;
  preview?: boolean;
  /** Optional subset of job ids to act on (default: all underbilled jobs in scope). */
  jobIds?: string[] | null;
}

/**
 * Compute (and, unless preview, post) unbilled-revenue accruals for underbilled jobs.
 * Throws PostingError if UNBILLED_RECEIVABLE (1180) can't be resolved.
 */
export async function runUnbilledAccrual(
  db: DB,
  orgId: string,
  args: RunUnbilledAccrualArgs,
): Promise<AccrualRunResult> {
  const period = periodOf(args.asOf);

  // Resolve the contract-asset account (role UNBILLED_RECEIVABLE → 1180). Throws
  // PostingError if unmapped/unseeded — the route surfaces that as a 422.
  const unbilled: AccountRef = await resolveRole(db, orgId, 'UNBILLED_RECEIVABLE');

  // Load candidate jobs (same eligibility window the rev-rec run uses).
  let q = db
    .schema('core')
    .from('jobs')
    .select(JOB_SELECT)
    .eq('org_id', orgId)
    .in('status', ['ACTIVE', 'COMPLETE', 'ON_HOLD']);
  if (args.locationId) q = q.eq('location_id', args.locationId);
  if (args.jobIds && args.jobIds.length > 0) q = q.in('id', args.jobIds);
  const { data: jobsRaw } = await q;
  const jobs = (jobsRaw ?? []) as unknown as JobRow[];

  // Compute WIP per job; keep only those relevant to the contract asset
  // (underbilled now, OR carrying a prior accrual that may need unwinding).
  const wipByJob = new Map<string, { earned: number; billed: number; under: number }>();
  for (const j of jobs) {
    const wip = computeWipJob({
      jobId: j.id,
      jobNumber: j.job_number ?? '',
      jobName: j.name ?? '',
      status: j.status,
      contractValueCents: Number(j.contract_amount_cents ?? 0),
      estimatedCostCents: Number(j.estimated_cost_cents ?? 0),
      costsToDateCents: Number(j.actual_cost_cents ?? 0),
      billedToDateCents: Number(j.billed_to_date_cents ?? 0),
      pctCompleteOverride: j.pct_complete != null ? Number(j.pct_complete) / 100 : null,
    });
    wipByJob.set(j.id, {
      earned: wip.earnedRevenueCents,
      billed: wip.billedToDateCents,
      under: wip.underBillingCents,
    });
  }

  const candidateIds = jobs.map((j) => j.id);
  const existingByJob = await loadContractAssetByJob(db, orgId, unbilled.id, candidateIds, args.asOf);
  const refs = candidateIds.map((id) => accrualSourceRef(id, period));
  const existingAccrualRefs = await loadExistingAccrualRefs(db, orgId, refs);

  const fallbackRevenue = await loadFallbackRevenueAccount(db, orgId);

  const result: AccrualRunResult = {
    asOf: args.asOf,
    period,
    preview: !!args.preview,
    unbilledAccount: { number: unbilled.account_number, name: '' },
    underbilledJobs: 0,
    jobsToPost: 0,
    totalUnderBillingCents: 0,
    existingContractAssetCents: 0,
    proposedDeltaCents: 0,
    projectedContractAssetCents: 0,
    posted: 0,
    reversed: 0,
    skipped: 0,
    jobs: [],
  };

  for (const j of jobs) {
    const wip = wipByJob.get(j.id)!;
    const existing = existingByJob.get(j.id) ?? 0;
    const plan = planUnbilledAccrual({
      earnedRevenueCents: wip.earned,
      billedToDateCents: wip.billed,
      existingContractAssetCents: existing,
    });

    // Only surface jobs that touch the contract asset: underbilled now, or
    // carrying a balance that a reversal would unwind. Skip fully-tied jobs.
    if (plan.targetContractAssetCents <= 0 && existing <= 0) continue;

    const row: AccrualJobResult = {
      jobId: j.id,
      jobNumber: j.job_number,
      jobName: j.name,
      locationId: j.location_id,
      earnedRevenueCents: wip.earned,
      billedToDateCents: wip.billed,
      underBillingCents: plan.targetContractAssetCents,
      existingContractAssetCents: existing,
      deltaCents: plan.deltaCents,
      action: plan.action,
      status: 'balanced',
    };

    if (plan.targetContractAssetCents > 0) result.underbilledJobs += 1;
    result.totalUnderBillingCents += plan.targetContractAssetCents;
    result.existingContractAssetCents += existing;

    const ref = accrualSourceRef(j.id, period);
    const alreadyAccrued = existingAccrualRefs.has(ref);

    if (plan.action === 'NONE') {
      row.status = alreadyAccrued ? 'already_accrued' : 'balanced';
      result.jobs.push(row);
      continue;
    }

    // A non-zero delta would post.
    result.jobsToPost += 1;
    result.proposedDeltaCents += plan.deltaCents;

    if (alreadyAccrued) {
      row.status = 'already_accrued';
      row.reason = 'An accrual for this job and period is already posted';
      result.jobs.push(row);
      continue;
    }

    const revenueAccountId = j.revenue_account_id ?? fallbackRevenue;
    if (!revenueAccountId) {
      row.status = 'skipped';
      row.reason = 'No revenue account to credit — set the job revenue account or seed a REVENUE account';
      result.skipped += 1;
      result.jobs.push(row);
      continue;
    }

    if (args.preview) {
      row.status = 'proposed';
      result.jobs.push(row);
      continue;
    }

    // ── POST ────────────────────────────────────────────────────────────────
    const lines = buildUnbilledAccrualLines(plan, {
      unbilledAccountId: unbilled.id,
      revenueAccountId,
      locationId: j.location_id,
      jobId: j.id,
    });

    const je = await postJournalEntry(db, {
      org_id: orgId,
      location_id: j.location_id,
      entry_date: args.asOf,
      entry_type: 'STANDARD',
      memo: `Unbilled revenue accrual (${period}) — ${j.job_number ?? j.id}`,
      source_module: ACCRUAL_SOURCE_MODULE,
      // Stable per job+period idempotency key. Migration 064's unique index on
      // (org_id, source_ref, entry_type) is the DB double-post guarantor.
      source_ref: ref,
      // GL author columns are uuid+nullable; Clerk actor ids don't cast (canon §2).
      created_by: null,
      lines,
    });

    if (!je.success || !je.entry_id) {
      row.status = 'skipped';
      row.reason = je.error ?? 'Posting failed';
      result.skipped += 1;
      result.jobs.push(row);
      continue;
    }

    row.entryNumber = je.entry_number;
    if (plan.action === 'ACCRUE') {
      row.status = 'accrued';
      result.posted += 1;
    } else {
      row.status = 'reversed';
      result.reversed += 1;
    }
    result.jobs.push(row);
  }

  result.projectedContractAssetCents = result.existingContractAssetCents + result.proposedDeltaCents;

  // Most material first (largest delta magnitude, then largest under-billing).
  result.jobs.sort(
    (a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents) || b.underBillingCents - a.underBillingCents,
  );

  return result;
}
