/**
 * Authentication for the scheduler's cron endpoints.
 *
 * Vercel Cron calls the path with `Authorization: Bearer <CRON_SECRET>` when the
 * project has a CRON_SECRET environment variable. We accept ONLY that: a
 * constant-time compare against a non-empty secret. FAILS CLOSED — if CRON_SECRET
 * is unset/blank the endpoint refuses everyone, so an empty header can never match
 * an empty env value. Clerk sessions are never consulted: a signed-in user, even a
 * platform admin, cannot fire a cross-tenant tick.
 */

import { timingSafeEqual } from 'node:crypto';

/** Shortest secret we accept — a guessable CRON_SECRET is treated as unset. */
export const MIN_CRON_SECRET_LENGTH = 16;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** PURE: does this Authorization header carry the configured cron secret? */
export function isAuthorizedCronRequest(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || secret.trim().length < MIN_CRON_SECRET_LENGTH) return false;
  if (!authorization) return false;
  const m = /^Bearer\s+(.+)$/.exec(authorization.trim());
  if (!m) return false;
  return safeEqual(m[1], secret);
}
