export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { clientIp, retryAfterSeconds, sharedRateLimiter } from '@/lib/security/rate-limit';
import { looksLikeRequestToken } from '@/lib/requests/tokens';
import { unsubscribeByToken } from '@/lib/requests/public-link';

const PER_IP = { windowMs: 60_000, max: 20 };

/**
 * POST /api/r/unsubscribe — the request email's "Stop these emails" (form post from
 * /r/[token]/unsubscribe). PUBLIC: the magic-link token is the credential (resolved by
 * sha256, service role). Raw route on purpose — the visitor has no Clerk session, so
 * apiHandler (which requires one) cannot front it; rate-limited per IP.
 */
export async function POST(req: Request) {
  const throttle = sharedRateLimiter.checkAll([{ key: `request-unsub:ip:${clientIp(req)}`, rule: PER_IP }]);
  if (!throttle.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(throttle)) } });
  }
  let token = '';
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    token = typeof body.token === 'string' ? body.token : '';
  } else {
    const form = await req.formData().catch(() => null);
    const v = form?.get('token');
    token = typeof v === 'string' ? v : '';
  }
  if (!looksLikeRequestToken(token)) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  const outcome = await unsubscribeByToken(createAdminSupabase(), token);
  if (outcome === 'invalid') return NextResponse.json({ error: 'This link has expired' }, { status: 410 });
  return NextResponse.redirect(new URL(`/r/${encodeURIComponent(token)}/unsubscribe?done=1`, req.url), 303);
}
