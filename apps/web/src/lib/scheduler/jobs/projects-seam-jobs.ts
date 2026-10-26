/**
 * projects.seam — the Merit Projects seam cycle for ONE tenant (migration 194).
 * Exported for the lead to register (lib/scheduler/registry.ts) right after `events.drain`:
 * `PROJECTS_SEAM_JOB` below is the full JobDefinition.
 *
 * Runs only for orgs with entitlements.projects = true (others: skipped — Books stands alone):
 *   1. JOB_COMMITMENT drain   (non-posting: AP match targets, payment holds)
 *   2. JOB_TIME drain         (non-posting: approved hours recorded)
 *   3. labor allocation sweep posted payroll runs with no (or a FAILED) job-labor allocation —
 *                             posts the reclass, so it asks the SCHEDULED_EVENT_DRAIN dial
 *                             (amount = the run's gross + employer tax); the human payroll post
 *                             normally allocates first and this is the retry.
 *   4. standard-rate accrual  on the 1st–3rd of a month, for companies that opted in
 *                             (job_labor_settings.accrue_standard_rate), as of the prior month end;
 *                             same dial.
 *   5. pm.run_seam_cycle(org) — Projects drains JOB_COST into its job-cost projection and reads
 *                             Books' acks (billing, deposits, commitment holds, dealer outbox), AFTER
 *                             the Books workers above and events.drain have run (BOOKS-SEAM-CHANGES §C).
 */

import { hasModule } from '@/lib/services/entitlements';
import { processCommitmentEvents, type CommitmentPayload } from '@/lib/projects-seam/commitments';
import { processJobTimeEvents, type JobTimePayload } from '@/lib/projects-seam/job-time';
import { allocateLaborForRun, payrollRunsAwaitingAllocation } from '@/lib/projects-seam/labor-allocation';
import { runLaborAccrual } from '@/lib/projects-seam/labor-accrual';
import { claimPendingEvents, newClaimToken } from '@/lib/events/claim';
import { postingGate, SCHEDULED_EVENT_DRAIN_FEATURE } from '../posting-gate';
import type { CountValue, JobContext, JobDefinition, JobResult } from '../types';

const num = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

function priorMonthEnd(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

export async function runProjectsSeamJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'The Projects seam runs per tenant.' };
  const orgId = ctx.orgId;
  const admin = ctx.admin;
  if (!(await hasModule(admin, orgId, 'projects').catch(() => false))) {
    return { status: 'skipped', summary: 'Merit Projects is not enabled for this organization.' };
  }

  const counts: Record<string, CountValue> = {};
  const failures: string[] = [];
  const waiting: string[] = [];
  let processed = 0;

  // 1–2. non-posting drains
  try {
    const c = await claimPendingEvents<CommitmentPayload>(admin, { eventType: 'JOB_COMMITMENT', orgId, token: newClaimToken('scheduler') });
    counts.commitment_pending = c.rows.length;
    if (c.rows.length > 0) {
      const r = await processCommitmentEvents(admin, orgId, { claimed: c });
      counts.commitment_processed = r.processed;
      counts.commitment_rejected = r.rejected;
      processed += r.processed;
    }
  } catch (e) {
    failures.push(`commitments: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ctx.signal.aborted) {
    try {
      const c = await claimPendingEvents<JobTimePayload>(admin, { eventType: 'JOB_TIME', orgId, token: newClaimToken('scheduler') });
      counts.time_pending = c.rows.length;
      if (c.rows.length > 0) {
        const r = await processJobTimeEvents(admin, orgId, { claimed: c });
        counts.time_processed = r.processed;
        counts.time_rejected = r.rejected;
        processed += r.processed;
      }
    } catch (e) {
      failures.push(`time: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. labor allocation sweep (posts → autonomy dial)
  if (!ctx.signal.aborted) {
    try {
      const runIds = await payrollRunsAwaitingAllocation(admin, orgId);
      counts.payroll_runs_awaiting_allocation = runIds.length;
      for (const runId of runIds) {
        if (ctx.signal.aborted) break;
        const { data: run } = await admin.from('payroll_runs').select('gross_cents, employer_tax_cents').eq('org_id', orgId).eq('id', runId).maybeSingle();
        const amount = run ? num((run as { gross_cents: unknown }).gross_cents) + num((run as { employer_tax_cents: unknown }).employer_tax_cents) : null;
        const gate = await postingGate(admin, orgId, SCHEDULED_EVENT_DRAIN_FEATURE, amount);
        if (!gate.allowed) { waiting.push('job labor allocation'); continue; }
        const r = await allocateLaborForRun(admin, orgId, runId);
        if (r.status === 'POSTED') { processed++; counts.labor_allocated_cents = num(counts.labor_allocated_cents) + r.allocatedCents; }
        if (r.status === 'FAILED') failures.push(`labor allocation ${runId}: ${r.error}`);
      }
    } catch (e) {
      failures.push(`labor allocation: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4. standard-rate accrual (opt-in companies, early in the month, as of the prior month end)
  if (!ctx.signal.aborted && ctx.now.getUTCDate() <= 3) {
    try {
      const { data: settings } = await admin.from('job_labor_settings').select('location_id').eq('org_id', orgId).eq('accrue_standard_rate', true);
      const asOf = priorMonthEnd(ctx.now);
      for (const s of (settings ?? []) as { location_id: string }[]) {
        const gate = await postingGate(admin, orgId, SCHEDULED_EVENT_DRAIN_FEATURE, null);
        if (!gate.allowed) { waiting.push('standard-rate labor accrual'); break; }
        const r = await runLaborAccrual(admin, orgId, { locationId: s.location_id, asOf, actor: 'system:scheduler' });
        if (r.status === 'POSTED' && !r.already) processed++;
        if (r.status === 'FAILED') failures.push(`labor accrual: ${r.error}`);
      }
    } catch (e) {
      failures.push(`labor accrual: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5. Projects' side of the cycle (JOB_COST drain + ack reconcile), after the Books workers.
  if (!ctx.signal.aborted) {
    const { data, error } = await admin.schema('pm').rpc('run_seam_cycle', { p_org: orgId });
    if (error) failures.push(`pm.run_seam_cycle: ${error.message}`);
    else counts.seam_cycle = data == null ? null : JSON.stringify(data).slice(0, 500);
  }

  const parts: string[] = [];
  if (processed > 0) parts.push(`Processed ${processed} Projects item(s).`);
  if (waiting.length > 0) parts.push(`Waiting for a human (autonomy dial): ${[...new Set(waiting)].join(', ')}.`);
  return {
    status: failures.length === 0 ? 'ok' : processed > 0 ? 'partial' : 'failed',
    itemsProcessed: processed,
    counts,
    summary: parts.join(' ') || 'Merit Projects seam is up to date.',
    error: failures.length ? failures.join('; ') : undefined,
  };
}

/** Registry entry for the lead (lib/scheduler/registry.ts) — runs 5 minutes after events.drain. */
export const PROJECTS_SEAM_JOB: JobDefinition = {
  key: 'projects.seam',
  label: 'Merit Projects seam cycle',
  description:
    'For clients that use Merit Projects: records commitments and approved hours, allocates posted payroll to jobs by hours, ' +
    'and runs the Projects seam cycle (job cost + acknowledgements). Posting steps wait for a human unless the "Scheduled Projects event drain" dial allows.',
  scope: 'org',
  cron: '25 * * * *',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'journal_entries.post',
  owner: 'Books Projects-seam consumers (migration 194)',
  postsToGl: true,
  autonomyFeature: SCHEDULED_EVENT_DRAIN_FEATURE,
  timeoutMs: 120_000,
  maxLatenessMinutes: 55,
  maxAttempts: 2,
  run: runProjectsSeamJob,
};
