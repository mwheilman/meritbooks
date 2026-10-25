/**
 * Front-door checks for the public booking widget (security review 2026-10-25). The database
 * enforces the hard limits (daily / per-phone / per-IP counters, lead time, hold expiry, server key);
 * these keep scripts out before they reach it:
 *   - a honeypot field (`website`) people never see,
 *   - a timing check: the form token from the availability call must be 3 s – 2 h old (HMAC-signed
 *     when FS_WIDGET_FORM_SECRET / FS_WIDGET_SERVER_KEY is set, so it cannot be forged),
 *   - a Cloudflare Turnstile-shaped challenge, verified when FS_TURNSTILE_SECRET is set. Without the
 *     secret it passes in development and tests, but FAILS CLOSED in production (VERCEL_ENV or
 *     NODE_ENV = production) unless FS_TURNSTILE_DISABLED=1 says so explicitly.
 * Pure except verifyChallenge (fetch is injectable for tests).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const FORM_MIN_MS = 3_000;
export const FORM_MAX_MS = 2 * 60 * 60 * 1000;

/** The end user's IP as Vercel reports it (first x-forwarded-for hop), else x-real-ip; trimmed and bounded. */
export function clientIp(h: { get(name: string): string | null }): string | null {
  const xf = h.get('x-forwarded-for');
  const first = xf ? xf.split(',')[0]?.trim() : null;
  const ip = first || h.get('x-real-ip')?.trim() || null;
  if (!ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  return ip;
}

/** True when a bot filled the hidden field. */
export function honeypotTripped(v: unknown): boolean {
  return typeof v === 'string' ? v.trim() !== '' : v != null && v !== false;
}

function sign(ts: string, secret: string): string {
  return createHmac('sha256', secret).update(`fs-widget:${ts}`).digest('hex').slice(0, 32);
}

/** A form token for the availability response: "<issued ms>" or "<issued ms>.<hmac>". */
export function issueFormToken(now: number, secret: string | null | undefined): string {
  const ts = String(Math.floor(now));
  return secret ? `${ts}.${sign(ts, secret)}` : ts;
}

export type FormCheck = { ok: true } | { ok: false; reason: 'missing' | 'forged' | 'too_fast' | 'expired' };

export function checkFormToken(token: unknown, now: number, secret: string | null | undefined): FormCheck {
  if (typeof token !== 'string' || !/^\d{10,16}(\.[0-9a-f]{32})?$/.test(token)) return { ok: false, reason: 'missing' };
  const [ts, mac] = token.split('.') as [string, string | undefined];
  if (secret) {
    if (!mac) return { ok: false, reason: 'forged' };
    const want = Buffer.from(sign(ts, secret));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'forged' };
  }
  const age = now - Number(ts);
  if (age < FORM_MIN_MS) return { ok: false, reason: 'too_fast' };
  if (age > FORM_MAX_MS) return { ok: false, reason: 'expired' };
  return { ok: true };
}

export interface ChallengeResult {
  ok: boolean;
  mode: 'disabled' | 'verified' | 'failed';
}

/** Where a missing secret is a misconfiguration (production) rather than development. */
export interface ChallengeRuntime {
  production: boolean;
  /** FS_TURNSTILE_DISABLED=1: run production without a challenge, on purpose. */
  explicitlyDisabled: boolean;
}

export function challengeRuntime(env: Readonly<Record<string, string | undefined>> = process.env): ChallengeRuntime {
  return {
    production: env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production',
    explicitlyDisabled: env.FS_TURNSTILE_DISABLED === '1',
  };
}

type FetchLike = (url: string, init: { method: string; body: URLSearchParams; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Turnstile-shaped verification (POST secret + response + remoteip to siteverify). With
 * FS_TURNSTILE_SECRET set, a missing or rejected token fails closed. Without it: passes in
 * development / tests; in production fails closed unless FS_TURNSTILE_DISABLED=1 (logged).
 * The fifth argument exists for tests; callers keep the four-argument form.
 */
export async function verifyChallenge(token: unknown, ip: string | null, env: { secret?: string | null; url?: string | null }, fetchImpl: FetchLike,
                                      runtime: ChallengeRuntime = challengeRuntime()): Promise<ChallengeResult> {
  if (!env.secret) {
    if (runtime.production && !runtime.explicitlyDisabled) {
      console.error('[widget-guard] FS_TURNSTILE_SECRET is not set in production; refusing (set it, or FS_TURNSTILE_DISABLED=1)');
      return { ok: false, mode: 'failed' };
    }
    return { ok: true, mode: 'disabled' };
  }
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return { ok: false, mode: 'failed' };
  try {
    const body = new URLSearchParams({ secret: env.secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetchImpl(env.url || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    if (!res.ok) return { ok: false, mode: 'failed' };
    const data = (await res.json()) as { success?: unknown };
    return data.success === true ? { ok: true, mode: 'verified' } : { ok: false, mode: 'failed' };
  } catch {
    return { ok: false, mode: 'failed' };
  }
}
