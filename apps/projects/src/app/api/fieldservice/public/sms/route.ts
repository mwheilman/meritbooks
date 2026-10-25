export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { twiml, verifyTwilioSignature } from '@/lib/notify/sms';
import { fsPublicRpc } from '@/lib/fieldservice/public-db';

/**
 * PUBLIC Twilio inbound-text webhook for two-way messaging (FS-12 / FS-22). Point the company's
 * Twilio number here instead of /api/webhooks/notifications/sms: public.fs_inbound_sms applies the
 * STOP / START / HELP keywords exactly as that route does (core.notify_inbound_sms), THEN files the
 * text on the customer's thread and applies a reply to an appointment reminder (C confirms,
 * R asks for a new time). The confirmation answer goes back as TwiML. Signature: X-Twilio-Signature
 * with TWILIO_AUTH_TOKEN against FS_SMS_WEBHOOK_URL (when the host rewrites the URL) or the request URL.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw).entries());
  const url = process.env.FS_SMS_WEBHOOK_URL || req.url;
  if (!verifyTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params, req.headers.get('x-twilio-signature'))) {
    return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
  }
  const xml = { 'Content-Type': 'text/xml; charset=utf-8' };
  const r = await fsPublicRpc<{ reply: string | null }>('fs_inbound_sms', {
    p_from: params.From ?? '', p_to: params.To ?? '', p_body: params.Body ?? '', p_sid: params.MessageSid ?? params.SmsSid ?? null,
  });
  if (r.error) {
    console.error('[fs sms inbound]', r.error.code, r.error.message);
    return new NextResponse(twiml(null), { status: 500, headers: xml });
  }
  return new NextResponse(twiml(r.data?.reply ?? null), { status: 200, headers: xml });
}
