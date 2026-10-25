export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { portalRpc } from '@/lib/portal/db';
import { PortalError } from '@/lib/portal/errors';
import { COOKIE_BASE } from '@/lib/portal/session';
import { trustedClientIp } from '@/lib/portal/ip';
import { isPortalToken, NONCE_COOKIE, SESSION_COOKIE, SESSION_MAX_AGE, newToken, sha256Hex } from '@/lib/portal/tokens';

/**
 * PUBLIC: the magic link. Redeemed only in the browser that asked for it (nonce cookie), once,
 * within 20 minutes; then a 30-day session cookie and on to the portal. Failures go to the sign-in
 * page with the reason (other device / used / expired / invalid).
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  const to = (path: string) => {
    const r = NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
    r.headers.set('Cache-Control', 'no-store');
    r.headers.set('Referrer-Policy', 'no-referrer');
    return r;
  };
  if (!isPortalToken(params.token)) return to('/portal/sign-in?reason=invalid');
  const nonce = req.cookies.get(NONCE_COOKIE)?.value ?? null;
  const session = newToken();
  const meta = { ip: trustedClientIp(req), userAgent: (req.headers.get('user-agent') ?? '').slice(0, 500) || null };
  let r: { ok: boolean; reason: string | null };
  try {
    r = await portalRpc('auth_redeem', { p_token: params.token, p_nonce: nonce, p_session_hash: sha256Hex(session), p_ip: meta.ip, p_user_agent: meta.userAgent });
  } catch (e) {
    return to(`/portal/sign-in?reason=${e instanceof PortalError ? e.code : 'unavailable'}`);
  }
  if (!r.ok) return to(`/portal/sign-in?reason=${encodeURIComponent(r.reason ?? 'invalid')}`);
  const res = to('/portal');
  res.cookies.set(SESSION_COOKIE, session, { ...COOKIE_BASE, maxAge: SESSION_MAX_AGE });
  res.cookies.set(NONCE_COOKIE, '', { ...COOKIE_BASE, maxAge: 0 });
  return res;
}
