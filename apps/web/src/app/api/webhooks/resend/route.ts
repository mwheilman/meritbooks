export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { applyResendEvent, verifySvixSignature, type ResendEvent } from '@/lib/notify/resend-webhook';

/**
 * POST /api/webhooks/resend — delivery events from Resend (delivered / opened / clicked /
 * bounced / complained) onto the request timeline (FPB-request-engine-notifications §4).
 *
 * Public at the middleware layer (/api/webhooks) — the Svix signature IS the credential:
 * verified in constant time against RESEND_WEBHOOK_SECRET over the RAW body, 5-minute
 * replay window, FAILS CLOSED (401) when the secret is unset or wrong. (Raw route on
 * purpose: apiHandler requires a Clerk session, which a provider webhook never has.)
 * The org comes from the matched send row, never from the payload.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const verdict = verifySvixSignature(
    process.env.RESEND_WEBHOOK_SECRET,
    { id: req.headers.get('svix-id'), timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') },
    raw,
  );
  if (!verdict.ok) return NextResponse.json({ error: 'Unauthorized', code: verdict.reason }, { status: 401 });

  let ev: ResendEvent;
  try {
    ev = JSON.parse(raw) as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON', code: 'PARSE_ERROR' }, { status: 400 });
  }
  try {
    const outcome = await applyResendEvent(createAdminSupabase(), req.headers.get('svix-id') as string, ev);
    // 200 for everything we understood (incl. unknown message ids) so Resend stops retrying.
    return NextResponse.json({ ok: true, outcome });
  } catch (e) {
    console.error('[webhooks/resend] apply failed:', e);
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
