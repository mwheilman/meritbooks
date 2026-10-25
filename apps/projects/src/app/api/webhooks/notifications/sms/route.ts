export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { verifyTwilioSignature, twiml } from '@/lib/notify/sms';
import { handleInboundSms } from '@/lib/notify/worker';

/**
 * Twilio inbound-message webhook: STOP / START / HELP keep the consent record and the suite STOP
 * list (core.request_suppressions, shared with Books dunning) current, and answer with TwiML.
 * Public path; authenticated by Twilio's X-Twilio-Signature (TWILIO_AUTH_TOKEN), so it cannot
 * use route(). TWILIO_WEBHOOK_URL must be the exact URL configured in Twilio when the host
 * rewrites it (proxies).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw).entries());
  const url = process.env.TWILIO_WEBHOOK_URL || req.url;
  if (!verifyTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params, req.headers.get('x-twilio-signature'))) {
    return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
  }
  try {
    const r = await handleInboundSms(params.From ?? '', params.To ?? '', params.Body ?? '');
    return new NextResponse(twiml(r?.reply ?? null), { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
  } catch (e) {
    console.error('[notify sms inbound]', e);
    // 500 makes Twilio retry; the keyword is applied idempotently
    return new NextResponse(twiml(null), { status: 500, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
  }
}
