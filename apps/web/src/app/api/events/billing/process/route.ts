export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { processBillingEvents } from '@/lib/services/billing-consumer';

/**
 * POST /api/events/billing/process
 * Drains pending JOB_BILLING events (Projects -> Books) into issued invoices.
 * Async, on-demand drain (no synchronous coupling with the emitter).
 */
export async function POST() {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminSupabase();
  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  if (!org) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  try {
    const result = await processBillingEvents(supabase, (org as { id: string }).id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}

// GET — peek at the JOB_BILLING queue (pending/processed/rejected counts + recent).
export async function GET() {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();
  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  if (!org) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const orgId = (org as { id: string }).id;

  const { data } = await supabase
    .schema('core').from('events')
    .select('event_id, status, invoice_id, error, occurred_on, created_at, payload')
    .eq('org_id', orgId)
    .eq('event_type', 'JOB_BILLING')
    .order('created_at', { ascending: false })
    .limit(50);
  return NextResponse.json({ data: data ?? [] });
}
