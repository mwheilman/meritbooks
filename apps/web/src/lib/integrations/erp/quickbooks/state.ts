/**
 * Signed, org-bound, expiring OAuth `state` for the QuickBooks connect flow.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret)).
 *
 * CSRF / mix-up defenses (all checked in the callback):
 *   1. Signature — HMAC with QBO_STATE_SECRET, compared in constant time. A tampered
 *      payload (e.g. swapping orgId) fails.
 *   2. Expiry — 10 minutes from issue.
 *   3. Browser binding — `nonce` is ALSO set as an httpOnly, SameSite=Lax cookie on
 *      the connect response; the callback requires cookie == state.nonce, so a state
 *      lifted from someone else's browser can't be replayed in yours.
 *   4. Identity binding — the callback requires the signed-in user AND resolved org
 *      to equal the state's userId/orgId, so tokens are never stored on another org.
 *
 * Pure (node:crypto only) — unit-tested without network or DB.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const QBO_STATE_TTL_MS = 10 * 60 * 1000;
export const QBO_NONCE_COOKIE = 'qbo_oauth_nonce';

export interface QboStatePayload {
  /** Resolved Books tenant uuid. */
  orgId: string;
  /** Clerk user id that started the flow. */
  userId: string;
  /** Random per-attempt value, mirrored in an httpOnly cookie. */
  nonce: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Relative in-app path to return to (validated by safeReturnTo). */
  returnTo: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function newNonce(): string {
  return b64url(randomBytes(24));
}

/**
 * Only allow same-app relative paths ("/onboarding?x=1"). Rejects absolute URLs,
 * protocol-relative "//evil.com", backslash tricks, and anything non-path — an open
 * redirect on an OAuth callback would leak the user to an attacker's page.
 */
export function safeReturnTo(raw: string | null | undefined, fallback = '/onboarding'): string {
  if (!raw) return fallback;
  const v = raw.trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || v.length > 512) return fallback;
  if (/[\u0000-\u001f]/.test(v)) return fallback;
  return v;
}

export function createQboState(
  input: Omit<QboStatePayload, 'exp'> & { exp?: number },
  secret: string,
  now: number = Date.now(),
): string {
  const payload: QboStatePayload = {
    orgId: input.orgId,
    userId: input.userId,
    nonce: input.nonce,
    returnTo: safeReturnTo(input.returnTo),
    exp: input.exp ?? now + QBO_STATE_TTL_MS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body, secret)}`;
}

export type QboStateCheck =
  | { ok: true; payload: QboStatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'nonce_mismatch' };

/**
 * Verify signature + expiry (+ the cookie nonce when supplied). Never throws.
 */
export function verifyQboState(
  state: string | null | undefined,
  secret: string,
  opts: { now?: number; cookieNonce?: string | null } = {},
): QboStateCheck {
  if (!state || typeof state !== 'string') return { ok: false, reason: 'malformed' };
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [body, sig] = parts;

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: QboStatePayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!isStatePayload(parsed)) return { ok: false, reason: 'malformed' };
    payload = parsed;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if ((opts.now ?? Date.now()) > payload.exp) return { ok: false, reason: 'expired' };

  if (opts.cookieNonce !== undefined) {
    const a = Buffer.from(opts.cookieNonce ?? '');
    const b = Buffer.from(payload.nonce);
    if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: 'nonce_mismatch' };
    }
  }
  return { ok: true, payload };
}

function isStatePayload(v: unknown): v is QboStatePayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.orgId === 'string' &&
    typeof o.userId === 'string' &&
    typeof o.nonce === 'string' &&
    typeof o.exp === 'number' &&
    typeof o.returnTo === 'string'
  );
}
