/**
 * `reports.governance_nightly` — make the release rule and the restatement log true without
 * anyone opening the reporting calendar (FPB §18.2):
 *   1. materialize AUTO releases the rule has made (row + baseline snapshot), newest first;
 *   2. re-hash every released month and log restatements (detection SCHEDULED).
 *
 * RLS-scoped tenant client only (ctx.scopedClient — the scheduler's SYSTEM org client, which
 * the scoped writer escalates with the org pin). Fails closed (skips) without one. No GL effect.
 *
 * REGISTRATION (lead — lib/scheduler/registry.ts is shared): add REPORT_GOVERNANCE_NIGHTLY_JOB.
 */

import type { JobContext, JobDefinition, JobResult } from '@/lib/scheduler/types';
import { materializeAutoReleases } from './releases';
import { checkRestatements } from './restatements';

export async function runReportGovernanceNightly(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  const client = ctx.scopedClient();
  if (!client) return { status: 'skipped', summary: 'No tenant-scoped client (SUPABASE_JWT_SECRET missing).' };
  const errors: string[] = [];
  let materialized = 0;
  let restated = 0;
  let checked = 0;
  try {
    materialized = (await materializeAutoReleases(client, ctx.orgId, { now: ctx.now })).materialized;
  } catch (e) {
    errors.push(`auto-release: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ctx.signal.aborted) {
    try {
      const r = await checkRestatements(client, ctx.orgId, { detection: 'SCHEDULED', actor: 'system:scheduler' });
      restated = r.restated;
      checked = r.checked;
    } catch (e) {
      errors.push(`restatements: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    status: errors.length === 0 ? 'ok' : materialized + checked > 0 ? 'partial' : 'failed',
    itemsProcessed: materialized + checked,
    counts: { materialized, checked, restated },
    summary: `${materialized} month(s) auto-released; ${checked} released month(s) checked, ${restated} restated.`,
    error: errors.length ? errors.join('; ') : undefined,
  };
}

export const REPORT_GOVERNANCE_NIGHTLY_JOB: JobDefinition = {
  key: 'reports.governance_nightly',
  label: 'Report releases and restatement check',
  description:
    'Records months the auto-release rule has released (with a snapshot of the reported totals) and re-checks every released month for changes, logging any restatement with its deltas and causing entries. No GL effect.',
  scope: 'org',
  cron: '40 6 * * *',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'close.package',
  owner: 'Number governance (FPB-tenant-model-consolidation-analytics §18)',
  postsToGl: false,
  timeoutMs: 240_000,
  maxLatenessMinutes: 360,
  maxAttempts: 2,
  run: (ctx) => runReportGovernanceNightly(ctx),
};
