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
 *
 * SCOPE: only the cron/secret caller drains across tenants; a signed-in member's
 * drain is confined to their own verified org (see ../../_auth.ts).
 */
export async function POST(req: Request) {
  const authz = await authorizeEventWorker(req, 'drain');
  if (!authz.ok) return authz.response;

  const supabase = createAdminSupabase();
  try {
    const result = await processBillingEvents(supabase, authz.orgId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}

// GET — peek at the JOB_BILLING queue (pending/processed/rejected counts + recent).
export async function GET(req: Request) {
  const authz = await authorizeEventWorker(req, 'peek');
  if (!authz.ok) return authz.response;
  const supabase = createAdminSupabase();

  // A signed-in member sees ONLY their own tenant's events; only the cron/secret
  // caller (scope 'all') may peek across tenants.
  let query = supabase
    .schema('core').from('events')
    .select('event_id, org_id, status, invoice_id, error, occurred_on, created_at, payload')
    .eq('event_type', 'JOB_BILLING');
  if (authz.orgId) query = query.eq('org_id', authz.orgId);
  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(50);
  return NextResponse.json({ data: data ?? [] });
}
