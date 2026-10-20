/**
 * `dealer.floor_plan_month_end` — Dealer Pack month-end (FPB §3.2, §6 DL-2).
 *
 * For every client with the dealer pack enabled:
 *   1. marks DUE curtailments past their date MISSED (DL-2 input);
 *   2. computes the floor-plan interest accrual through the last day of the prior
 *      month and stores it as PROPOSED rows (a human posts it from the floor-plan
 *      screen / POST /api/dealer/interest/accrue {post:true});
 *   3. posts the batch JE ONLY when the tenant raised the DEALER_INTEREST_ACCRUAL
 *      autonomy dial to AUTO_UNDER_LIMIT and the total is under its cap (posting-gate).
 * Payoffs are never touched here — releasing money is always a person (FPB §2.2).
 *
 * Reads run on the per-org RLS client; dealer writes need the service role (mig 169
 * revokes member writes), and every dealer service pins org_id + location_id explicitly.
 *
 * REGISTRATION (lead — registry.ts is shared): add `DEALER_MONTH_END_JOB` to JOBS and
 * `DEALER_INTEREST_FEATURE` to lib/autonomy/catalog.ts.
 */

import type { JobContext, JobDefinition, JobResult } from '../types';
import { scopedOrFail, isoDate, lastDayOfPriorMonth, dollars } from './shared';
import { postingGate } from '../posting-gate';
import { DEALER_INTEREST_FEATURE, accrueInterest, markMissedCurtailments } from '@/lib/dealer/service/floor-plan';
import type { DealerCtx } from '@/lib/dealer/service/context';

export const DEALER_JOB_ACTOR = 'system:scheduler';

export async function runDealerMonthEndJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const { data, error } = await s.db
    .from('dealer_pack_settings')
    .select('location_id')
    .eq('org_id', s.orgId)
    .eq('enabled', true);
  if (error) return { status: 'failed', error: `Dealer settings lookup failed: ${error.message}` };
  const locations = ((data ?? []) as { location_id: string }[]).map((r) => r.location_id);
  if (locations.length === 0) return { status: 'skipped', summary: 'No client has the dealer pack enabled.' };

  const periodEnd = lastDayOfPriorMonth(ctx.now);
  const today = isoDate(ctx.now);
  let proposedCents = 0;
  let postedCents = 0;
  let missed = 0;
  const failures: string[] = [];
  for (const locationId of locations) {
    if (ctx.signal.aborted) break;
    const d: DealerCtx = { userId: DEALER_JOB_ACTOR, orgId: s.orgId, locationId, db: s.db, admin: ctx.admin };
    try {
      missed += await markMissedCurtailments(d, today);
      const preview = await accrueInterest(d, { periodEnd, post: false });
      if (preview.totalCents === 0) continue;
      const gate = await postingGate(s.db, s.orgId, DEALER_INTEREST_FEATURE, preview.totalCents);
      if (gate.allowed) {
        const posted = await accrueInterest(d, { periodEnd, post: true });
        postedCents += posted.totalCents;
      } else {
        proposedCents += preview.totalCents;
      }
    } catch (e) {
      failures.push(`${locationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const status = failures.length === 0 ? 'ok' : failures.length === locations.length ? 'failed' : 'partial';
  return {
    status,
    itemsProcessed: locations.length,
    counts: { clients: locations.length, proposedCents, postedCents, missedCurtailments: missed, failures: failures.length },
    summary: `Floor-plan interest through ${periodEnd}: ${dollars(postedCents)} posted, ${dollars(proposedCents)} awaiting approval; ${missed} curtailment(s) newly missed.`,
    ...(failures.length ? { error: failures.slice(0, 5).join('; ') } : {}),
  };
}

export const DEALER_MONTH_END_JOB: JobDefinition = {
  key: 'dealer.floor_plan_month_end',
  label: 'Dealer pack month-end (floor-plan interest + curtailments)',
  description:
    'Proposes the floor-plan interest accrual through month end for every dealer client and marks missed curtailments. Posts only when the DEALER_INTEREST_ACCRUAL autonomy dial allows.',
  scope: 'org',
  cron: '30 8 1 * *', // 1st of the month, ~02:30–03:30 CT
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'dealer.floor_plan',
  owner: 'Dealer pack (FPB-dealer-pack §3.2)',
  postsToGl: true,
  autonomyFeature: DEALER_INTEREST_FEATURE,
  timeoutMs: 120_000,
  maxLatenessMinutes: 24 * 60,
  maxAttempts: 3,
  run: runDealerMonthEndJob,
};
