/**
 * Portal secrets. The raw values exist only in the cookie / link / message; the database keeps
 * SHA-256 (portal._h). Server-side (node:crypto).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const SESSION_COOKIE = 'mp_portal';
export const NONCE_COOKIE = 'mp_portal_n';
export const LOCALE_COOKIE = 'mp_portal_lang';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
export const NONCE_MAX_AGE = 60 * 20;

/** 256 bits, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Same rule as portal._session / auth_redeem. */
export function isPortalToken(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.length >= 20 && s.length <= 200 && /^[A-Za-z0-9_-]+$/.test(s);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID.test(s);
}

/** An email address or a phone number with 10–15 digits (the database normalizes). Pure. */
export function isAddress(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || /^\+?[0-9 ().-]{10,20}$/.test(v.trim());
}
