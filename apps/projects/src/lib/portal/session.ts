import 'server-only';
/**
 * Portal session cookies (httpOnly, Secure, SameSite=Lax). The session value is the raw token; the
 * database keeps its sha-256. The nonce cookie binds a sign-in link / code to this browser.
 */
import { cookies, headers } from 'next/headers';
import { PortalError } from './errors';
import { parseLocale } from './i18n';
import { isPortalToken, LOCALE_COOKIE, NONCE_COOKIE, SESSION_COOKIE } from './tokens';
import type { Locale } from './types';

export function sessionToken(): string | null {
  const v = cookies().get(SESSION_COOKIE)?.value ?? null;
  return isPortalToken(v) ? v : null;
}

export function requireSessionToken(): string {
  const v = sessionToken();
  if (!v) throw new PortalError(401, 'auth', 'Sign in again.');
  return v;
}

export function nonceValue(): string | null {
  const v = cookies().get(NONCE_COOKIE)?.value ?? null;
  return isPortalToken(v) ? v : null;
}

/** The person's language: cookie first, then the browser's Accept-Language. */
export function portalLocale(): Locale {
  const c = cookies().get(LOCALE_COOKIE)?.value;
  if (c) return parseLocale(c);
  return /^es\b/i.test(headers().get('accept-language') ?? '') ? 'es' : 'en';
}

export const COOKIE_BASE = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
