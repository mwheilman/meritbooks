export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { verifyTwilioSignature } from '@/lib/notify/sms';
import {
  normalizeDialpad, normalizeRingCentral, normalizeTwilio, providerFromSlug, ringCentralSetupOpen, verifyDialpadJwt, verifyRingCentral, voiceConfig, type VoiceEvent,
} from '@/lib/fieldservice/telephony';
import { fsPublicRpc } from '@/lib/fieldservice/public-db';

/**
 * PUBLIC provider webhooks (FS-05): /api/fieldservice/public/voice/{ringcentral|dialpad|twilio}.
 * Each provider stays OFF until its credentials are in the environment; the route verifies the
 * provider's signature, normalizes the call event and records it through public.fs_voice_event
 * (anon key + FS_WIDGET_SERVER_KEY; fails closed). The database ignores numbers no company set up
 * and companies that have not switched the provider on (pm.fs_set_phone_provider).
 * RingCentral's subscription handshake (Validation-Token) is echoed back only inside the setup window
 * (RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL). The company comes only from the platform's verified-number
 * registry (pm.fs_voice_numbers).
 */
export async function POST(req: NextRequest, { params }: { params: { provider: string } }): Promise<NextResponse> {
  const provider = providerFromSlug(params.provider);
  if (!provider) return NextResponse.json({ error: 'Unknown provider.', code: 'NOT_FOUND' }, { status: 404 });
  const cfg = voiceConfig(provider);
  if (!cfg.configured) return NextResponse.json({ error: 'This phone provider is not connected.', code: 'NOT_CONFIGURED' }, { status: 503 });
  const raw = await req.text();
  let ev: VoiceEvent | null = null;
  if (provider === 'RINGCENTRAL') {
    const validation = req.headers.get('validation-token');
    if (validation) {
      // the subscription handshake is answered only inside the setup window (security review L)
      if (!ringCentralSetupOpen() || !/^[A-Za-z0-9._-]{1,200}$/.test(validation)) return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
      return new NextResponse(null, { status: 200, headers: { 'Validation-Token': validation } });
    }
    if (!verifyRingCentral(req.headers.get('verification-token'))) return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
    try { ev = normalizeRingCentral(JSON.parse(raw)); } catch { ev = null; }
  } else if (provider === 'DIALPAD') {
    const payload = verifyDialpadJwt(raw, process.env.DIALPAD_WEBHOOK_SECRET);
    if (!payload) return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
    ev = normalizeDialpad(payload);
  } else {
    const form = Object.fromEntries(new URLSearchParams(raw).entries());
    const url = process.env.FS_VOICE_WEBHOOK_URL ? `${process.env.FS_VOICE_WEBHOOK_URL.replace(/\/+$/, '')}/twilio` : req.url;
    if (!verifyTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, form, req.headers.get('x-twilio-signature'))) {
      return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
    }
    ev = normalizeTwilio(form);
  }
  if (!ev) return NextResponse.json({ ok: true, ignored: 'not a call event' });
  const r = await fsPublicRpc<{ status: string; reason?: string }>('fs_voice_event', { p_provider: provider, p_event: ev });
  if (r.error) {
    console.error('[fs voice]', provider, r.error.code, r.error.message);
    // 500 makes the provider retry; the event is applied idempotently per call id
    return NextResponse.json({ error: 'Not recorded yet.', code: 'RETRY' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...(r.data ?? {}) });
}
