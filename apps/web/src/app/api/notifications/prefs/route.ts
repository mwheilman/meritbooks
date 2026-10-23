export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { membershipIdFor } from '@/lib/notify/in-app';
import { notificationPrefsBody } from '@/lib/validations/requests';

/**
 * /api/notifications/prefs — the caller's OWN notification preferences (core.notification_prefs).
 * GET reads through RLS (own row only); PUT writes through the service role pinned to the
 * caller's org + membership (member-SELECT-only table, migration 178).
 */

export const GET = apiQueryHandler(null, async (_q, { orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ prefs: null });
  const { data } = await supabase.schema('core').from('notification_prefs').select('channels, digest, quiet_start, quiet_end, timezone, muted_kinds').eq('org_id', orgId).maybeSingle();
  return NextResponse.json({ prefs: data ?? { channels: ['in_app', 'email'], digest: 'instant', quiet_start: null, quiet_end: null, timezone: null, muted_kinds: [] } });
});

export const PUT = apiHandler(notificationPrefsBody, async (b, { userId, orgId }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const writer = serviceWriter();
  const membershipId = await membershipIdFor(writer, orgId, userId);
  if (!membershipId) return NextResponse.json({ error: 'No active membership', code: 'FORBIDDEN' }, { status: 403 });
  const values = { digest: b.digest, channels: b.channels ?? ['in_app', 'email'], updated_at: new Date().toISOString() };
  const { data: existing } = await writer.schema('core').from('notification_prefs').select('id').eq('org_id', orgId).eq('membership_id', membershipId).maybeSingle();
  const { error } = existing
    ? await writer.schema('core').from('notification_prefs').update(values).eq('id', (existing as { id: string }).id).eq('org_id', orgId)
    : await writer.schema('core').from('notification_prefs').insert({ ...values, org_id: orgId, membership_id: membershipId });
  if (error) return NextResponse.json({ error: error.message, code: 'WRITE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true, prefs: values });
});
