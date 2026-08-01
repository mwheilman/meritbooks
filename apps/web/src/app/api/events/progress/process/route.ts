export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { processProgressEvents } from '@/lib/services/job-progress';

// NEEDS CENTRAL: queue-drain worker — should resolve the org PER EVENT (each
// core.events row carries its own org_id) rather than pin the drain to the first
// org. Left on first-org intentionally until per-event org resolution lands
// (out of scope for the gate-#9 org-source fix).
async function orgId(supabase: ReturnType<typeof createAdminSupabase>) {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

/** POST /api/events/progress/process — drain pending JOB_PROGRESS events (Projects → Books). */
export async function POST() {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();
  const id = await orgId(supabase);
  if (!id) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const result = await processProgressEvents(supabase, id, userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}

/** GET — peek at the JOB_PROGRESS queue. */
export async function GET() {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();
  const id = await orgId(supabase);
  if (!id) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data } = await supabase
    .schema('core').from('events')
    .select('event_id, status, error, occurred_on, created_at, payload')
    .eq('org_id', id)
    .eq('event_type', 'JOB_PROGRESS')
    .order('created_at', { ascending: false })
    .limit(50);
  return NextResponse.json({ data: data ?? [] });
}
