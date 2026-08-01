export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { processBillingEvents } from '@/lib/services/billing-consumer';
import { authorizeEventWorker } from '../../_auth';

/**
 * POST /api/events/billing/process
 * Drains pending JOB_BILLING events (Projects -> Books) into issued invoices.
 * Async, on-demand drain (no synchronous coupling with the emitter).
 *
 * PER-EVENT ORG: each core.events row carries its own org_id (FROZEN v3); the
 * consumer posts every event under THAT event's org, so a single drain safely
 * spans all tenants without cross-tenant posting. No first-org pin.
 */
export async function POST(req: Request) {
  const authz = await authorizeEventWorker(req);
  if (!authz.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminSupabase();
  try {
    const result = await processBillingEvents(supabase);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}

// GET — peek at the JOB_BILLING queue (pending/processed/rejected counts + recent).
export async function GET(req: Request) {
  const authz = await authorizeEventWorker(req);
  if (!authz.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();

  const { data } = await supabase
    .schema('core').from('events')
    .select('event_id, org_id, status, invoice_id, error, occurred_on, created_at, payload')
    .eq('event_type', 'JOB_BILLING')
    .order('created_at', { ascending: false })
    .limit(50);
  return NextResponse.json({ data: data ?? [] });
}
