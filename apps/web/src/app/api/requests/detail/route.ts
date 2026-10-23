export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { describeCadence, quietHoursOf } from '@/lib/requests/cadence';
import { REQUESTS_VIEW, requireAny } from '@/lib/requests/route-auth';
import type { RequestRow } from '@/lib/requests/types';
import { requestDetailQuery } from '@/lib/validations/requests';

/**
 * GET /api/requests/detail?id= — one request and its full timeline (every ask, channel,
 * provider id, skip / defer / escalation / bounce). RLS-scoped read as the member.
 */
export const GET = apiQueryHandler(requestDetailQuery, async ({ id }, { userId, orgId, supabase }) => {
  const guard = await requireAny(userId, REQUESTS_VIEW, '/api/requests/detail');
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { data: r, error } = await supabase.schema('core').from('requests').select('*').eq('id', id).eq('org_id', orgId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_FAILED' }, { status: 500 });
  if (!r) return NextResponse.json({ error: 'Request not found', code: 'NOT_FOUND' }, { status: 404 });
  const request = r as RequestRow;

  const { data: events, error: evErr } = await supabase
    .schema('core')
    .from('request_events')
    .select('id, event_type, step, channel, delivery_status, provider, provider_message_id, detail, actor, occurred_at')
    .eq('org_id', orgId)
    .eq('request_id', id)
    .order('occurred_at', { ascending: true })
    .limit(500);
  if (evErr) return NextResponse.json({ error: evErr.message, code: 'QUERY_FAILED' }, { status: 500 });

  let clientName: string | null = null;
  if (request.location_id) {
    const { data: loc } = await supabase.schema('core').from('locations').select('name').eq('id', request.location_id).maybeSingle();
    clientName = (loc as { name?: string } | null)?.name ?? null;
  }

  const { meta, ...rest } = request;
  return NextResponse.json({
    request: { ...rest, doc_types: Array.isArray(meta?.doc_types) ? meta.doc_types : [], has_portal_link: typeof meta?.vendor_portal_token_id === 'string' },
    clientName,
    cadenceText: describeCadence({ offsetsMinutes: request.cadence_offsets_minutes, repeatEveryMinutes: request.repeat_every_minutes }, request.cadence_anchor),
    quiet: quietHoursOf(request.quiet_start, request.quiet_end),
    events: events ?? [],
  });
});
