/**
 * Per-USER throttles for authenticated endpoints that are expensive (AI calls) or enumerable
 * (the parties matcher) — security review M3 / LOW. Same process-local fixed-window limiter as
 * the public token routes (`sharedRateLimiter`, lib/security/rate-limit.ts): best-effort per
 * instance; it blunts loops and scripted enumeration, while the AI gateway's tenant budget stays
 * the hard cost cap.
 */

import { NextResponse } from 'next/server';
import { retryAfterSeconds, sharedRateLimiter, type RateLimitRule, type RateLimiter } from './rate-limit';

export const USER_LIMITS = {
  /** "Summarize this view" (FP&A) — an AI call per press. */
  fpnaSummarize: { windowMs: 60_000, max: 10 },
  /** Onboarding account-mapping AI suggestions. */
  mappingAi: { windowMs: 60_000, max: 10 },
  /** "Already in Merit" lookups (name / email / phone / TIN probes). */
  partiesMatch: { windowMs: 60_000, max: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type UserLimitKey = keyof typeof USER_LIMITS;

/** Null when allowed; else the 429 to return (with Retry-After). */
export function userRateLimited(limit: UserLimitKey, userId: string, limiter: RateLimiter = sharedRateLimiter): NextResponse | null {
  const outcome = limiter.check(`user-limit:${limit}:${userId}`, USER_LIMITS[limit]);
  if (outcome.allowed) return null;
  const seconds = retryAfterSeconds(outcome);
  return NextResponse.json(
    { error: `Too many requests — try again in ${seconds} second${seconds === 1 ? '' : 's'}.`, code: 'RATE_LIMITED' },
    { status: 429, headers: { 'Retry-After': String(seconds) } },
  );
}
