/**
 * The close's view of the month-end WIP review (FPB-rev-rec-wip §5) — the RLS-scoped loader
 * that feeds the `wip_accrual_reviewed` close task (lib/close/orchestration.ts).
 *
 * Applicable when the company has at least one WIP job (open status, contract > 0, not
 * excluded) AND accrues underbillings or defers overbillings (policy row, or the defaults).
 * Then the month's latest live run decides:
 *   POSTED / NO_CHANGE / DISMISSED (with a reason)  → the task passes
 *   PROPOSED / FAILED / no run yet                   → the task blocks hard close
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WipCloseSignal } from '@/lib/close/orchestration';
import { policyFromRow, type RevRecPolicyRow } from './policy';
import { WIP_JOB_STATUSES } from './wip-run-service';

type DB = SupabaseClient;

interface RunRow {
  location_id: string;
  status: string;
  revision: number;
  job_count: number;
  underbilled_cents: number | string;
  overbilled_cents: number | string;
  loss_provision_cents: number | string;
  dismiss_reason: string | null;
  reversal_pending: boolean;
}

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** Signals for many companies for one month. A read error fails CLOSED for every company asked about. */
export async function loadWipCloseSignals(
  db: DB,
  orgId: string,
  periodKey: string,
  locationIds: string[],
): Promise<Map<string, WipCloseSignal>> {
  const out = new Map<string, WipCloseSignal>();
  if (locationIds.length === 0) return out;
  try {
    const [policies, jobs, overrides, runs] = await Promise.all([
      db.from('rev_rec_policies').select('location_id, accrue_underbillings, defer_overbillings').eq('org_id', orgId).in('location_id', locationIds),
      db.schema('core').from('jobs').select('id, location_id, contract_amount_cents').eq('org_id', orgId).in('location_id', locationIds)
        .in('status', [...WIP_JOB_STATUSES]).gt('contract_amount_cents', 0),
      db.from('rev_rec_job_overrides').select('job_id').eq('org_id', orgId).eq('exclude_from_wip', true).in('location_id', locationIds),
      db.from('rev_rec_wip_runs')
        .select('location_id, status, revision, job_count, underbilled_cents, overbilled_cents, loss_provision_cents, dismiss_reason, reversal_pending')
        .eq('org_id', orgId).eq('period_key', periodKey).in('location_id', locationIds).neq('status', 'SUPERSEDED'),
    ]);
    for (const r of [policies, jobs, overrides, runs]) if (r.error) throw new Error(r.error.message);

    const excluded = new Set(((overrides.data ?? []) as { job_id: string }[]).map((r) => r.job_id));
    const jobsByLoc = new Map<string, number>();
    for (const j of (jobs.data ?? []) as { id: string; location_id: string }[]) {
      if (excluded.has(j.id)) continue;
      jobsByLoc.set(j.location_id, (jobsByLoc.get(j.location_id) ?? 0) + 1);
    }
    const policyByLoc = new Map(
      ((policies.data ?? []) as (RevRecPolicyRow & { location_id: string })[]).map((p) => [p.location_id, policyFromRow(p)]),
    );
    const runsByLoc = new Map<string, RunRow[]>();
    for (const r of (runs.data ?? []) as RunRow[]) runsByLoc.set(r.location_id, [...(runsByLoc.get(r.location_id) ?? []), r]);

    for (const loc of locationIds) {
      const policy = policyByLoc.get(loc) ?? policyFromRow(null);
      const wipJobs = jobsByLoc.get(loc) ?? 0;
      const applicable = wipJobs > 0 && (policy.accrueUnderbillings || policy.deferOverbillings);
      const list = (runsByLoc.get(loc) ?? []).sort((a, b) => b.revision - a.revision);
      const run = list.find((r) => r.status === 'PROPOSED') ?? list[0] ?? null;
      out.set(loc, {
        applicable,
        status: run ? (run.status as WipCloseSignal['status']) : 'NOT_RUN',
        jobs: run ? n(run.job_count) : wipJobs,
        underbilledCents: run ? n(run.underbilled_cents) : 0,
        overbilledCents: run ? n(run.overbilled_cents) : 0,
        lossProvisionCents: run ? n(run.loss_provision_cents) : 0,
        dismissReason: run?.dismiss_reason ?? null,
        reversalPending: run?.reversal_pending ?? false,
      });
    }
  } catch (e) {
    console.warn('[rev-rec/wip-close-signal] read failed — failing closed:', e instanceof Error ? e.message : e);
    for (const loc of locationIds) {
      out.set(loc, {
        applicable: true, status: 'UNKNOWN', jobs: 0, underbilledCents: 0, overbilledCents: 0, lossProvisionCents: 0,
        dismissReason: null, reversalPending: false,
      });
    }
  }
  return out;
}
