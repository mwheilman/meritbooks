export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { listSeamHealth } from '@/lib/pm/money/queries';
import { callRpc } from '@/lib/pm/money/rpc';

/** pm.v_seam_health for the caller's org: what is waiting on Merit Books, how old, and the alarm. */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' } }, async ({ db, tenant }) => ({ rows: await listSeamHealth(db), booksPresent: tenant.booksPresent }));

interface Reconcile { billing_issued: number; billing_rejected: number; deposits_issued: number; deposits_rejected: number; invoice_numbers_filled: number }
interface Refresh { status: 'ok' | 'busy'; applied?: number; stale?: number; rejected?: number; duplicate?: number; seen?: number }

/** Check now: reconcile_my_billing (Books acks → ISSUED / REJECTED) then refresh_job_costs (JOB_COST in). */
export const POST = route({ access: { cap: 'projects.billing', action: 'edit' } }, async ({ db }) => {
  const reconcile = await callRpc<Reconcile>(db, 'reconcile_my_billing', {}, 'record');
  const costs = await callRpc<Refresh>(db, 'refresh_job_costs', {}, 'record');
  return { reconcile, costs, rows: await listSeamHealth(db) };
});
