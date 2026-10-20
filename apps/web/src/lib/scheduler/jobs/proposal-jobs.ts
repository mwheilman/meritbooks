/**
 * Scheduled jobs whose engines are already PROPOSAL-ONLY (never post to the GL):
 *
 *   vendors.compliance_scan  flips expired W-9/COI docs, advances the chase cadence,
 *                            and escalates high-risk vendors into /exceptions
 *                            (same pass as "Run maintenance" on Vendor compliance).
 *                            No message is sent yet — the sender is `requests.remind`.
 *   recurring_je.propose     stages every due recurring-JE period as a PROPOSED run
 *                            for a human to approve + post (journal_entries:post).
 *
 * Both run on the per-org RLS-scoped client.
 */

import { runComplianceMaintenance } from '@/lib/services/vendor-compliance';
import { assessAndEscalate } from '@/lib/compliance/assess';
import { generateDue } from '@/lib/recurring-je/store';
import type { JobContext, JobResult } from '../types';
import { isoDate, scopedOrFail } from './shared';

export async function runVendorComplianceScanJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const maint = await runComplianceMaintenance(s.db, s.orgId);
  const assessed = await assessAndEscalate(s.db, s.orgId);
  return {
    status: 'ok',
    itemsProcessed: maint.expired + maint.chased + assessed.queued,
    counts: {
      expired: maint.expired,
      chases_scheduled: maint.chased,
      vendors_assessed: assessed.assessed,
      escalated: assessed.escalated,
      exceptions_queued: assessed.queued,
    },
    summary: `${maint.expired} document(s) expired, ${maint.chased} chase(s) scheduled, ${assessed.queued} vendor(s) escalated to Exceptions.`,
  };
}

export async function runRecurringJeProposeJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const res = await generateDue(s.db, s.orgId, { asOf: isoDate(ctx.now) });
  const proposed = res.proposed.length;
  const failed = res.errors.length;
  return {
    status: failed === 0 ? 'ok' : proposed > 0 ? 'partial' : 'failed',
    itemsProcessed: proposed,
    counts: { templates: res.templates_processed, proposed, already_proposed: res.skipped_existing, errors: failed },
    summary: `${proposed} recurring entr${proposed === 1 ? 'y' : 'ies'} proposed for review (nothing posted).`,
    error: failed ? res.errors.map((e) => `${e.template_id} ${e.period}: ${e.error}`).join('; ') : undefined,
  };
}
