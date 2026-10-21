/**
 * `reports.packs` — deliver this tenant's due scheduled report packs (IA §6.1 step 14).
 * Delivery only happens for packs a user explicitly scheduled (active + cadence +
 * recipients); ledger reads stay on the per-org RLS-scoped client inside the engine.
 */

import type { JobContext, JobResult } from '../types';

// Loaded lazily: the PDF renderer is heavy and, if it ever fails to load in the
// serverless bundle, it must fail THIS job — not crash /api/cron/tick and every
// other scheduled job with it (seen 2026-10-21: an unhandled module-load error in
// the PDF stack killed the whole tick).

export async function runReportPacksJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'Report packs run per tenant.' };
  const today = ctx.now.toISOString().slice(0, 10);
  let deliverDuePacks: typeof import('@/lib/reports/compiler/scheduled-delivery').deliverDuePacks;
  try {
    ({ deliverDuePacks } = await import('@/lib/reports/compiler/scheduled-delivery'));
  } catch (e) {
    return { status: 'failed', error: `Report pack engine failed to load: ${e instanceof Error ? e.message : String(e)}` };
  }
  const res = await deliverDuePacks(ctx.admin, { orgId: ctx.orgId, today, signal: ctx.signal });
  if (!res.ok) return { status: 'failed', error: res.error };
  if (!res.available) return { status: 'skipped', summary: 'Report packs are not set up in this environment.' };
  if (res.processed === 0) return { status: 'ok', itemsProcessed: 0, summary: 'No packs were due.' };

  const counts = { due: res.processed, delivered: res.delivered, failed: res.failed, skipped: res.skipped };
  const summary = `Delivered ${res.delivered} of ${res.processed} due pack(s)${res.failed ? `, ${res.failed} failed` : ''}${res.skipped ? `, ${res.skipped} skipped` : ''}.`;
  const status = res.failed === 0 ? 'ok' : res.delivered > 0 || res.skipped > 0 ? 'partial' : 'failed';
  return {
    status,
    itemsProcessed: res.delivered,
    counts,
    summary,
    error: res.failed ? res.results.filter((r) => r.status === 'FAILED').map((r) => `${r.name}: ${r.detail ?? 'failed'}`).join('; ') : undefined,
  };
}
