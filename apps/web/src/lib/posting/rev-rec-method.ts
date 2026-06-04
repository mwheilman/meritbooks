/**
 * Revenue-recognition method policy (billing side).
 *
 * Billing is decoupled from recognition. Whether a customer invoice / progress
 * bill credits Revenue (recognize now) or Deferred Revenue (a contract liability
 * the rev-rec engine earns out later) depends on the resolved rev-rec method for
 * that revenue type:
 *
 *   POINT_OF_SALE, AS_BILLED            → billing IS recognition → credit Revenue
 *   PCT_*, COMPLETED_CONTRACT, MILESTONE,
 *   RATABLY, SUBSCRIPTION, CASH         → defer → credit Deferred Revenue; the
 *                                          rev-rec engine recognizes separately
 *
 * Method resolves: per-job override → per-revenue-type → company default. This is
 * the same precedence the rev-rec engine uses, so billing and recognition never
 * disagree about a stream's treatment (which would double- or under-count).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RevRecMethod } from '../services/rev-rec';

type DB = SupabaseClient;

/** Methods where issuing the bill is itself the recognition event. */
export function recognizesAtBilling(method: RevRecMethod): boolean {
  return method === 'POINT_OF_SALE' || method === 'AS_BILLED';
}

/**
 * Resolve the rev-rec method for a billing event:
 *   1. the job's override (core.jobs.rev_rec_method_override), if a job is given
 *   2. the per-revenue-type method (revenue_type_methods) for the revenue account
 *   3. the company default (core.locations.rev_rec_method)
 */
export async function resolveBillingRevRecMethod(
  db: DB,
  args: { orgId: string; locationId: string; revenueAccountId: string; jobId?: string }
): Promise<RevRecMethod> {
  // 1. per-job override
  if (args.jobId) {
    const { data: job } = await db
      .schema('core')
      .from('jobs')
      .select('rev_rec_method_override')
      .eq('org_id', args.orgId)
      .eq('id', args.jobId)
      .maybeSingle();
    const override = (job as { rev_rec_method_override: RevRecMethod | null } | null)?.rev_rec_method_override;
    if (override) return override;
  }

  // 2. per-revenue-type method
  const { data: rt } = await db
    .from('revenue_type_methods')
    .select('method')
    .eq('org_id', args.orgId)
    .eq('location_id', args.locationId)
    .eq('revenue_account_id', args.revenueAccountId)
    .maybeSingle();
  const byType = (rt as { method: RevRecMethod } | null)?.method;
  if (byType) return byType;

  // 3. company default
  const { data: loc } = await db
    .schema('core')
    .from('locations')
    .select('rev_rec_method')
    .eq('id', args.locationId)
    .maybeSingle();
  return (loc as { rev_rec_method: RevRecMethod } | null)?.rev_rec_method ?? 'PCT_COSTS_INCURRED';
}

/** True when a bill against this revenue type should credit Deferred Revenue. */
export async function shouldDeferAtBilling(
  db: DB,
  args: { orgId: string; locationId: string; revenueAccountId: string; jobId?: string }
): Promise<boolean> {
  const method = await resolveBillingRevRecMethod(db, args);
  return !recognizesAtBilling(method);
}
