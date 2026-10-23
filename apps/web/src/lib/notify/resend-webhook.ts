/**
 * Resend delivery webhooks → the request timeline (FPB-request-engine-notifications §4).
 *
 * Resend signs webhooks with Svix: headers `svix-id`, `svix-timestamp`, `svix-signature`
 * ("v1,<base64> v1,<base64>"), secret `whsec_<base64 key>`, signed content
 * `${id}.${timestamp}.${rawBody}` (HMAC-SHA256). We verify in constant time, reject
 * anything older than 5 minutes, and fail CLOSED when RESEND_WEBHOOK_SECRET is unset.
 *
 * Mapping (by provider message id → the request's `sent` event):
 *   email.delivered → delivered · email.opened → opened · email.clicked → clicked
 *   email.bounced (hard) → bounced + suppression + request.bounced_at + owner notified
 *   email.complained → complained + suppression + request.unsubscribed_at
 * Each webhook id is recorded once (dispatch_key `wh:<svix-id>`), so Resend's retries are
 * harmless. Service role; the org comes from the matched event row, never the payload.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordEvent } from '@/lib/requests/events';
import { notifyMembers, tenantAdminMemberships } from './in-app';
import type { RequestRow } from '@/lib/requests/types';

const TOLERANCE_S = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: 'not_configured' | 'missing_headers' | 'stale' | 'bad_signature' };

export function verifySvixSignature(
  secret: string | null | undefined,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!secret || !secret.startsWith('whsec_') || secret.length < 16) return { ok: false, reason: 'not_configured' };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_S) return { ok: false, reason: 'stale' };
  let key: Buffer;
  try {
    key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  } catch {
    return { ok: false, reason: 'not_configured' };
  }
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of signature.split(' ')) {
    const [ver, sig] = part.split(',');
    if (ver !== 'v1' || !sig) continue;
    let got: Buffer;
    try {
      got = Buffer.from(sig, 'base64');
    } catch {
      continue;
    }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

export interface ResendEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

const MAP: Record<string, 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained'> = {
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

export type ApplyOutcome = 'applied' | 'duplicate' | 'ignored' | 'unknown_message';

export async function applyResendEvent(admin: SupabaseClient, webhookId: string, ev: ResendEvent, now: Date = new Date()): Promise<ApplyOutcome> {
  const kind = MAP[ev.type];
  const messageId = ev.data?.email_id;
  if (!kind || !messageId) return 'ignored';

  const { data: sent } = await admin
    .schema('core')
    .from('request_events')
    .select('id, org_id, request_id, channel')
    .eq('provider_message_id', messageId)
    .eq('channel', 'email')
    .limit(1)
    .maybeSingle();
  const s = sent as { id: string; org_id: string; request_id: string } | null;
  if (!s) return 'unknown_message';

  const { data: reqRow } = await admin.schema('core').from('requests').select('*').eq('id', s.request_id).eq('org_id', s.org_id).maybeSingle();
  const r = reqRow as RequestRow | null;
  if (!r) return 'unknown_message';

  const hard = kind === 'bounced' && (ev.data?.bounce?.type ?? 'Permanent').toLowerCase() !== 'transient';
  const rec = await recordEvent(
    admin,
    r,
    {
      event_type: kind,
      channel: 'email',
      provider: 'resend',
      provider_message_id: messageId,
      dispatch_key: `wh:${webhookId}`,
      detail: kind === 'bounced' ? `${hard ? 'Hard' : 'Soft'} bounce${ev.data?.bounce?.message ? `: ${ev.data.bounce.message}` : ''}` : null,
      actor: 'provider:resend',
    },
    now,
  );
  if (rec.duplicate) return 'duplicate';

  if ((kind === 'bounced' && hard) || kind === 'complained') {
    const addr = r.recipient_email?.toLowerCase();
    if (addr) {
      await admin
        .schema('core')
        .from('request_suppressions')
        .insert({ org_id: r.org_id, location_id: r.location_id, channel: 'email', address: addr, reason: kind === 'bounced' ? 'bounce' : 'complaint', source_request_id: r.id })
        .then(() => undefined, () => undefined);
    }
    await admin
      .schema('core')
      .from('requests')
      .update(kind === 'bounced' ? { bounced_at: now.toISOString(), updated_at: now.toISOString() } : { unsubscribed_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', r.id)
      .eq('org_id', r.org_id);
    const targets = r.owner_membership_id ? [r.owner_membership_id] : await tenantAdminMemberships(admin, r.org_id);
    await notifyMembers(admin, targets, {
      orgId: r.org_id,
      locationId: r.location_id,
      kind: kind === 'bounced' ? 'request.bounced' : 'request.complained',
      severity: 'attention',
      title: kind === 'bounced' ? `Email bounced: ${r.recipient_email ?? r.recipient_name ?? 'recipient'}` : `Marked as spam: ${r.title}`.slice(0, 200),
      body: kind === 'bounced' ? `The request "${r.title}" can't reach this address. Fix the email to resume the chase.` : 'The recipient reported the email; we will not email them again.',
      deepLink: `/requests?id=${r.id}`,
      requestId: r.id,
      dedupeKey: `${kind}:${r.id}`,
    });
  }
  return 'applied';
}
