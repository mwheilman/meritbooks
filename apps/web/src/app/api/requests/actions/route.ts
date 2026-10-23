export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { defaultChannels, outboundAppUrl } from '@/lib/notify/channels';
import { REQUESTS_WORK, requireAny } from '@/lib/requests/route-auth';
import { cancelRequest, fulfilRequest, RequestError, sendNow, snoozeRequest } from '@/lib/requests/service';
import { requestActionBody } from '@/lib/validations/requests';
import { consumeSendQuota } from '@/lib/email/send-quota';

/**
 * POST /api/requests/actions — Send now · Snooze · Cancel · Mark fulfilled.
 *
 * Authorized (compliance:manage or vendors:edit), then the request is READ through the
 * member's own RLS client (proves it is in their org AND client scope) before the
 * service role writes it (core.requests is member-SELECT-only, migration 178). "Send now"
 * is metered against the outbound email quota. Cancel / fulfil also revoke the vendor
 * upload link the request minted (lib/requests/service).
 */
export const POST = apiHandler(requestActionBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requireAny(userId, REQUESTS_WORK, '/api/requests/actions');
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { data: visible } = await supabase.schema('core').from('requests').select('id, status, recipient_email, channels').eq('id', b.id).eq('org_id', orgId).maybeSingle();
  if (!visible) return NextResponse.json({ error: 'Request not found', code: 'NOT_FOUND' }, { status: 404 });

  const deps = { db: serviceWriter(), channels: defaultChannels(), now: () => new Date(), appUrl: outboundAppUrl() };
  try {
    switch (b.action) {
      case 'send_now': {
        // "Send now" is a member-triggered email: metered like any other (lib/email/send-quota).
        const v = visible as { recipient_email: string | null; channels: string[] | null };
        if (v.recipient_email && (v.channels ?? []).includes('email')) {
          const q = await consumeSendQuota(orgId, userId, 1, 'request');
          if (!q.ok) return NextResponse.json({ error: q.error, code: q.code }, { status: q.status, headers: { 'Retry-After': String(q.retryAfterSec) } });
        }
        const res = await sendNow(deps, orgId, b.id, userId);
        const msg =
          res.outcome === 'sent'
            ? 'Sent.'
            : res.outcome === 'deferred'
              ? `It's quiet hours for the recipient, so it goes at ${res.nextSendAt}.`
              : res.outcome === 'fulfilled'
                ? 'Already answered — the request is closed.'
                : res.outcome === 'expired'
                  ? 'This request has used all its reminders, so it was closed.'
                  : res.outcome === 'undeliverable'
                    ? `Couldn't send: ${res.channels.map((c) => c.reason).filter(Boolean).join(' ')}`
                    : res.outcome === 'failed'
                      ? `The email provider refused it; we'll retry in 15 minutes. ${res.channels.map((c) => c.reason).filter(Boolean).join(' ')}`
                      : 'Nothing to send right now.';
        return NextResponse.json({ outcome: res.outcome, nextSendAt: res.nextSendAt, message: msg });
      }
      case 'snooze': {
        const r = await snoozeRequest(deps, orgId, b.id, userId, new Date(b.until));
        return NextResponse.json({ outcome: 'snoozed', request: r, message: `Snoozed until ${r.snoozed_until}.` });
      }
      case 'cancel': {
        const r = await cancelRequest(deps, orgId, b.id, userId, b.reason);
        return NextResponse.json({ outcome: 'cancelled', request: r, message: 'Cancelled. No more reminders will go out.' });
      }
      case 'fulfil': {
        const r = await fulfilRequest(deps, orgId, b.id, userId, { via: 'manual', note: b.note ?? null });
        return NextResponse.json({ outcome: 'fulfilled', request: r, message: 'Marked fulfilled.' });
      }
    }
  } catch (e) {
    if (e instanceof RequestError) return NextResponse.json({ error: e.message, code: 'REQUEST_INVALID' }, { status: e.status });
    throw e;
  }
});
