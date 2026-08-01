export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { processProgressEvents } from '@/lib/services/job-progress';
import { authorizeEventWorker } from '../../_auth';

/**
 * POST /api/events/progress/process — drain pending JOB_PROGRESS events (Projects → Books).
 *
 * PER-EVENT ORG: each core.events row carries its own org_id (FROZEN v3); the
 * consumer pins/recognizes under THAT event's org. No first-org pin.
 */
export async function POST(req: Request) {
  const authz = await authorizeEventWorker(req);
  if (!authz.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();
  try {
    const result = await processProgressEvents(supabase, undefined, authz.userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Drain failed' }, { status: 500 });
  }
}

/** GET — peek at the JOB_PROGRESS queue. */
export async function GET(req: Request) {
  const authz = await authorizeEventWorker(req);
  if (!authz.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();

  const { data } = await supabase
    .schema('core').from('events')
    .select('event_id, org_id, status, error, occurred_on, created_at, payload')
    .eq('event_type', 'JOB_PROGRESS')
    .order('created_at', { ascending: false })
    .limit(50);
  return NextResponse.json({ data: data ?? [] });
}
