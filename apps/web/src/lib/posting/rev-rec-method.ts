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
 * Method resolves through lib/rev-rec/method.ts: per-job override → per-revenue-type →
 * legacy job_type map → company default. This is the same precedence the rev-rec engine uses, so billing and recognition never
 * disagree about a stream's treatment (which would double- or under-count).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RevRecMethod } from '../services/rev-rec';
import { resolveJobRevRecMethod } from '@/lib/rev-rec/method';

type DB = SupabaseClient;

/** Methods where issuing the bill is itself the recognition event. */
export function recognizesAtBilling(method: RevRecMethod): boolean {
  return method === 'POINT_OF_SALE' || method === 'AS_BILLED';
}

/**
 * Resolve the rev-rec method for a billing event — delegates to THE resolver
 * (lib/rev-rec/method.ts, A5) so billing uses exactly the precedence recognition uses:
 *   1. the job's override  2. the per-revenue-type method for the BILLED line's revenue account
 *   3. the legacy job_type map  4. the company default.
 */
export async function resolveBillingRevRecMethod(
  db: DB,
  args: { orgId: string; locationId: string; revenueAccountId: string; jobId?: string }
): Promise<RevRecMethod> {
  return resolveJobRevRecMethod(db, {
    orgId: args.orgId,
    locationId: args.locationId,
    jobId: args.jobId ?? null,
    revenueAccountId: args.revenueAccountId,
  });
}

/** True when a bill against this revenue type should credit Deferred Revenue. */
export async function shouldDeferAtBilling(
  db: DB,
  args: { orgId: string; locationId: string; revenueAccountId: string; jobId?: string }
): Promise<boolean> {
  const method = await resolveBillingRevRecMethod(db, args);
  return !recognizesAtBilling(method);
}
