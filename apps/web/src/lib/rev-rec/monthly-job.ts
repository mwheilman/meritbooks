/**
 * `revrec.monthly` — the scheduled month-end WIP run (FPB-rev-rec-wip §3–§5). The scheduler
 * key and cadence are unchanged (lib/scheduler/registry.ts, 07:00 on the 1st); the registry
 * imports this through lib/scheduler/jobs/gl-gated-jobs.ts.
 *
 * For every active company whose policy runs MONTHLY_AT_CLOSE, it computes the prior month's
 * WIP schedule and saves it as a PROPOSED run (the close checklist then shows "WIP: review
 * proposed accrual"). It POSTS only when BOTH say so — the stricter wins:
 *   • the company policy is AUTO_POST, and
 *   • the tenant's SCHEDULED_REV_REC autonomy dial is AUTO_UNDER_LIMIT with the entry's
 *     gross adjustment within the cap (kill switch → never).
 * Otherwise the proposal waits for a human (journal_entries:post) on the WIP screen.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postingGate, SCHEDULED_REV_REC_FEATURE } from '@/lib/scheduler/posting-gate';
import { dollars, lastDayOfPriorMonth, scopedOrFail } from '@/lib/scheduler/jobs/shared';
import type { CountValue, JobContext, JobResult } from '@/lib/scheduler/types';
import { loadCompanyPolicy, postWipRun, proposeWipRun } from './wip-run-service';

/** Actor recorded on scheduler-approved runs. */
export const SCHEDULER_ACTOR = 'system:scheduler';

export async function runRevRecMonthlyJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const db: SupabaseClient = s.db;
  const orgId = s.orgId;
  const asOf = lastDayOfPriorMonth(ctx.slotAt);
  const periodKey = asOf.slice(0, 7);

  const { data: locs, error } = await db.schema('core').from('locations').select('id, short_code').eq('org_id', orgId).eq('is_active', true);
  if (error) return { status: 'failed', error: `Could not list companies: ${error.message}` };

  let proposed = 0;
  let posted = 0;
  let noChange = 0;
  let onDemand = 0;
  let proposedCents = 0;
  const failures: string[] = [];
  const counts: Record<string, CountValue> = { as_of: asOf };

  for (const loc of (locs ?? []) as { id: string; short_code: string | null }[]) {
    if (ctx.signal.aborted) break;
    const label = loc.short_code ?? loc.id.slice(0, 8);
    try {
      const { policy } = await loadCompanyPolicy(db, orgId, loc.id);
      if (policy.runCadence !== 'MONTHLY_AT_CLOSE') { onDemand++; continue; }

      const res = await proposeWipRun(db, orgId, { locationId: loc.id, periodKey, requestedBy: null, source: 'SCHEDULER' });
      if (res.outcome === 'no_jobs') continue;
      if (res.outcome !== 'proposed' || !res.run) { noChange++; continue; }

      const gross = Number(res.run.gross_adjustment_cents) + Math.abs(Number(res.run.reclass_cents));
      if (policy.postingMode === 'AUTO_POST') {
        const gate = await postingGate(ctx.admin, orgId, SCHEDULED_REV_REC_FEATURE, gross);
        counts[`${label}_gate`] = gate.disposition;
        if (gate.allowed) {
          await postWipRun(db, orgId, { runId: res.run.id, approvedBy: SCHEDULER_ACTOR });
          posted++;
          continue;
        }
      }
      proposed++;
      proposedCents += gross;
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  Object.assign(counts, { proposed, posted, no_change: noChange, on_demand: onDemand, failed: failures.length });
  const parts: string[] = [];
  if (proposed > 0) parts.push(`Proposed the ${periodKey} WIP entry for ${proposed} compan${proposed === 1 ? 'y' : 'ies'} (${dollars(proposedCents)} to review) — approve it from the WIP schedule.`);
  if (posted > 0) parts.push(`Posted the ${periodKey} WIP entry for ${posted} compan${posted === 1 ? 'y' : 'ies'} (within your auto-post limit).`);
  if (noChange > 0) parts.push(`${noChange} compan${noChange === 1 ? 'y is' : 'ies are'} already up to date.`);
  if (parts.length === 0 && failures.length === 0) parts.push(`No jobs on the WIP schedule for ${periodKey}.`);

  return {
    status: failures.length === 0 ? 'ok' : proposed + posted + noChange > 0 ? 'partial' : 'failed',
    itemsProcessed: proposed + posted,
    counts,
    summary: parts.join(' '),
    error: failures.length ? failures.join('; ') : undefined,
  };
}
