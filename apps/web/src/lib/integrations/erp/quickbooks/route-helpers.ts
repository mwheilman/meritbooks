/**
 * Small helpers shared by the /api/integrations/erp/quickbooks/* routes.
 */

import { NextResponse } from 'next/server';
import { QBO_NONCE_COOKIE, safeReturnTo } from './state';

/** Cookie scope: only the QBO routes ever see the nonce. */
export const QBO_COOKIE_PATH = '/api/integrations/erp/quickbooks';

/**
 * Outcome codes appended to the return URL as `?qbo=<code>` so the onboarding UI can
 * show the right plain-English message after the round-trip to Intuit.
 */
export type QboReturnCode =
  | 'connected'
  | 'cancelled'
  | 'not_configured'
  | 'forbidden'
  | 'expired'
  | 'error';

/** Redirect to a same-app path with `?qbo=<code>` (+ optional `qbo_reason`). */
export function redirectToApp(
  request: Request,
  returnTo: string | null | undefined,
  code: QboReturnCode,
  reason?: string,
): NextResponse {
  const url = new URL(safeReturnTo(returnTo), request.url);
  url.searchParams.set('qbo', code);
  if (reason) url.searchParams.set('qbo_reason', reason.slice(0, 200));
  const res = NextResponse.redirect(url, { status: 303 });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export function setNonceCookie(res: NextResponse, nonce: string, maxAgeSec: number): void {
  res.cookies.set(QBO_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // Intuit returns via a top-level GET navigation — Lax is sent.
    path: QBO_COOKIE_PATH,
    maxAge: maxAgeSec,
  });
}

export function clearNonceCookie(res: NextResponse): void {
  res.cookies.set(QBO_NONCE_COOKIE, '', { httpOnly: true, path: QBO_COOKIE_PATH, maxAge: 0 });
}

/** Read one cookie from a raw Request (route handlers get the standard Request). */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
