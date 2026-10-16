export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { processDeptInvoiceEvents } from '@/lib/services/dept-invoice-consumer';
import { authorizeEventWorker } from '../../_auth';

/**
 * DEPT_INVOICE_ISSUE drain — posts intercompany eliminating entries, so it is now
 * guarded exactly like the billing/progress workers (was previously unguarded).
 *
 * PER-EVENT ORG: each core.events row carries its own org_id (FROZEN v3); the
 * consumer books every internal invoice under THAT event's org. No first-org pin.
 */

/** GET — peek the DEPT_INVOICE_ISSUE queue (pending/processed/rejected counts + recent). */
export async function GET(req: Request) {
  const authz = await authorizeEventWorker(req, 'peek');
  if (!authz.ok) return authz.response;
  const supabase = createAdminSupabase();

  const counts: Record<string, number> = {};
  for (const status of ['pending', 'processed', 'rejected'] as const) {
    let countQuery = supabase
      .schema('core').from('events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'DEPT_INVOICE_ISSUE').eq('status', status);
    if (authz.orgId) countQuery = countQuery.eq('org_id', authz.orgId);
    const { count } = await countQuery;
    counts[status] = count ?? 0;
  }
  // Members see only their own tenant; only the cron/secret caller spans tenants.
  let recentQuery = supabase
    .schema('core').from('events')
    .select('event_id, org_id, status, invoice_number, occurred_on, error')
    .eq('event_type', 'DEPT_INVOICE_ISSUE');
  if (authz.orgId) recentQuery = recentQuery.eq('org_id', authz.orgId);
  const { data: recent } = await recentQuery
    .order('created_at', { ascending: false })
    .limit(20);

  return NextResponse.json({ ok: true, counts, recent: recent ?? [] });
}

/** POST — drain pending DEPT_INVOICE_ISSUE events. */
export async function POST(req: Request) {
  const authz = await authorizeEventWorker(req, 'drain');
  if (!authz.ok) return authz.response;
  const supabase = createAdminSupabase();
  try {
    const result = await processDeptInvoiceEvents(supabase, authz.orgId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}
