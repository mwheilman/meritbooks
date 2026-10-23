export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { membershipIdFor } from '@/lib/notify/in-app';
import { notificationsMarkBody, notificationsQuery } from '@/lib/validations/requests';

/**
 * /api/notifications — the caller's OWN in-app notifications (IA M-13, migration 178).
 *
 * GET   newest first + the unread count. Read through the member's RLS client: the
 *       policy only returns rows whose membership_id is the caller's (org + client scope).
 * POST  mark read ({ ids } or { all: true }). The table is member-SELECT-only, so the
 *       write is the service role pinned to the caller's org AND membership — a member can
 *       never mark (or learn about) anyone else's notifications.
 */

export const GET = apiQueryHandler(notificationsQuery, async (q, { orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ items: [], unread: 0 });
  let list = supabase
    .schema('core')
    .from('notifications')
    .select('id, kind, severity, title, body, deep_link, request_id, read_at, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(Math.min(100, Math.max(1, Number(q.limit ?? 30))));
  if (q.unread === '1') list = list.is('read_at', null);
  const [items, unread, critical] = await Promise.all([
    list,
    supabase.schema('core').from('notifications').select('id', { count: 'exact', head: true }).eq('org_id', orgId).is('read_at', null),
    supabase.schema('core').from('notifications').select('id', { count: 'exact', head: true }).eq('org_id', orgId).is('read_at', null).in('severity', ['attention', 'critical']),
  ]);
  if (items.error) return NextResponse.json({ error: items.error.message, code: 'QUERY_FAILED' }, { status: 500 });
  return NextResponse.json({ items: items.data ?? [], unread: unread.count ?? 0, attention: critical.count ?? 0 });
});

export const POST = apiHandler(notificationsMarkBody, async (b, { userId, orgId }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const writer = serviceWriter();
  const membershipId = await membershipIdFor(writer, orgId, userId);
  if (!membershipId) return NextResponse.json({ error: 'No active membership', code: 'FORBIDDEN' }, { status: 403 });
  let q = writer
    .schema('core')
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('membership_id', membershipId)
    .is('read_at', null);
  if (!b.all) q = q.in('id', b.ids ?? []);
  const { data, error } = await q.select('id');
  if (error) return NextResponse.json({ error: error.message, code: 'WRITE_FAILED' }, { status: 500 });
  return NextResponse.json({ marked: (data ?? []).length });
});
