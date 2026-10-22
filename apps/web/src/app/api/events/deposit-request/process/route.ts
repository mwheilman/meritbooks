export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { processDepositRequestEvents } from '@/lib/services/deposit-request-consumer';
import { authorizeEventWorker } from '../../_auth';

/**
 * POST /api/events/deposit-request/process
 * Drains pending JOB_DEPOSIT_REQUEST events (Projects -> Books, migration 173) into
 * deposit invoices (DR AR / CR Customer Deposits) + the deposits subledger.
 *
 * PER-EVENT ORG: every read/insert/post is pinned to the event's own org_id. Only the
 * cron/secret caller drains across tenants; a signed-in member's drain is confined to
 * their own verified org (see ../../_auth.ts). Runs only for orgs with Projects on.
 */
export async function POST(req: Request) {
  const authz = await authorizeEventWorker(req, 'drain');
  if (!authz.ok) return authz.response;

  const supabase = createAdminSupabase();
  try {
    const result = await processDepositRequestEvents(supabase, authz.orgId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}

// GET — peek at the JOB_DEPOSIT_REQUEST queue (own tenant only unless cron/secret).
export async function GET(req: Request) {
  const authz = await authorizeEventWorker(req, 'peek');
  if (!authz.ok) return authz.response;
  const supabase = createAdminSupabase();
  let query = supabase
    .schema('core').from('events')
    .select('event_id, org_id, status, invoice_id, invoice_number, error, error_code, ack_meta, occurred_on, created_at, payload')
    .eq('event_type', 'JOB_DEPOSIT_REQUEST');
  if (authz.orgId) query = query.eq('org_id', authz.orgId);
  const { data } = await query.order('created_at', { ascending: false }).limit(50);
  return NextResponse.json({ data: data ?? [] });
}
