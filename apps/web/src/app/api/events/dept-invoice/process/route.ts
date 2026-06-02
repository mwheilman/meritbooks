export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { processDeptInvoiceEvents } from '@/lib/services/dept-invoice-consumer';

async function orgId(supabase: ReturnType<typeof createAdminSupabase>) {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

/** GET — peek the DEPT_INVOICE_ISSUE queue (pending/processed/rejected counts + recent). */
export async function GET() {
  const supabase = createAdminSupabase();
  const id = await orgId(supabase);
  if (!id) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const counts: Record<string, number> = {};
  for (const status of ['pending', 'processed', 'rejected'] as const) {
    const { count } = await supabase
      .schema('core').from('events')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', id).eq('event_type', 'DEPT_INVOICE_ISSUE').eq('status', status);
    counts[status] = count ?? 0;
  }
  const { data: recent } = await supabase
    .schema('core').from('events')
    .select('event_id, status, invoice_number, occurred_on, error')
    .eq('org_id', id).eq('event_type', 'DEPT_INVOICE_ISSUE')
    .order('created_at', { ascending: false })
    .limit(20);

  return NextResponse.json({ ok: true, counts, recent: recent ?? [] });
}

/** POST — drain pending DEPT_INVOICE_ISSUE events. */
export async function POST() {
  const supabase = createAdminSupabase();
  const id = await orgId(supabase);
  if (!id) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const result = await processDeptInvoiceEvents(supabase, id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}
