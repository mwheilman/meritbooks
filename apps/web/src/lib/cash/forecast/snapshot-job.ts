/**
 * `cash.forecast_snapshot` — the weekly forecast snapshot + minimum-cash alerts (Wave 4C, AC-CF7 /
 * AC-CF8). FOR THE LEAD TO REGISTER in lib/scheduler/registry.ts (reserved spine):
 *
 *   import { CASH_FORECAST_SNAPSHOT_JOB } from '@/lib/cash/forecast/snapshot-job';
 *   // … in JOBS:
 *   CASH_FORECAST_SNAPSHOT_JOB,
 *
 * Mondays 11:00 UTC (early morning US), per tenant: snapshots the BASE 13-week forecast for every
 * company and the combined view (one row per company × week — re-running that week is a no-op), so
 * forecast-vs-actual accuracy can be scored, and raises one critical in-app notification per
 * company × week whose projected closing falls below its minimum. Reads through the tenant-scoped
 * system client (fails closed when it can't be minted); writes the snapshot / event rows with the
 * service-role client and an explicit org_id. No GL effect; nothing moves money.
 */

import { getOrgToday } from '@/lib/dates/org-today';
import type { JobContext, JobDefinition, JobResult } from '@/lib/scheduler/types';
import { scopedOrFail } from '@/lib/scheduler/jobs/shared';
import { takeSnapshots } from './service';

export async function runCashForecastSnapshotJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  try {
    const today = await getOrgToday(s.db, s.orgId, ctx.now);
    const out = await takeSnapshots(s.db, ctx.admin, { orgId: s.orgId, today, source: 'SCHEDULED', actor: 'system:cash.forecast_snapshot' });
    const breach = out.breaches.length
      ? ` ${out.breaches.length} compan${out.breaches.length === 1 ? 'y drops' : 'ies drop'} below minimum (${out.alerts} new alert${out.alerts === 1 ? '' : 's'}).`
      : ' No company drops below its minimum.';
    return {
      status: 'ok',
      itemsProcessed: out.written,
      counts: { anchor_date: out.anchorDate, snapshots: out.written, already_taken: out.skipped, breaches: out.breaches.length, alerts: out.alerts },
      summary:
        out.written === 0 && out.skipped === 0
          ? 'No companies to forecast.'
          : `Saved ${out.written} forecast snapshot${out.written === 1 ? '' : 's'} for the week of ${out.anchorDate}${out.skipped ? ` (${out.skipped} already taken)` : ''}.${breach}`,
    };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : 'Cash forecast snapshot failed.' };
  }
}

export const CASH_FORECAST_SNAPSHOT_JOB: JobDefinition = {
  key: 'cash.forecast_snapshot',
  label: 'Weekly cash forecast snapshot',
  description:
    'Mondays: saves the 13-week cash forecast as it stands (per company and combined) so forecast accuracy can be measured week by week, and alerts finance admins when a company is projected to fall below its minimum cash. No GL effect.',
  scope: 'org',
  cron: '0 11 * * 1',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'cash.forecast',
  owner: 'Cash & forecast (FPB-reports-fpna §4.12)',
  postsToGl: false,
  timeoutMs: 120_000,
  maxLatenessMinutes: 24 * 60,
  maxAttempts: 3,
  run: runCashForecastSnapshotJob,
};
