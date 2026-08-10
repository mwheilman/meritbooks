/**
 * Deterministic, process-local rate limiter for the UNAUTHENTICATED public token
 * endpoints (vendor upload, customer statement PDF, hosted-pay intent).
 *
 * These routes carry no tenant session — the opaque token in the path is the only
 * credential — so they are the app's most abusable surface: unbounded 15 MB
 * uploads, repeated server-side PDF renders, repeated Stripe PaymentIntent
 * creation. This limiter throttles per-token AND per-IP with a short fixed window
 * so a hostile client is capped without hurting a normal visitor (who makes a
 * handful of requests).
 *
 * Design notes / honest limits:
 *  - Fixed-window counter in a module-level Map (same accepted pattern as
 *    `app/api/observability/client-error`). It is **per-instance, best-effort**:
 *    on serverless it resets on cold start and is not shared across instances.
 *    That is a deliberate, in-lane choice — a DB-backed limiter would need a new
 *    table (reserved-spine migration) which this task must not add. Per-instance
 *    throttling still blunts the burst/loop abuse these findings target.
 *  - The clock is injectable so the behaviour is unit-testable without timers.
 *  - `createRateLimiter()` yields an isolated store (used by tests); routes share
 *    the process-wide `sharedRateLimiter`.
 */

export type Clock = () => number;

export interface RateLimitRule {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Maximum requests permitted per key within the window. */
  readonly max: number;
}

export interface RateLimitOutcome {
  /** True when the request is within the limit(s). */
  readonly allowed: boolean;
  /** Requests still available in the current window (0 when blocked). */
  readonly remaining: number;
  /** Milliseconds until the window resets (0 when allowed). */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  /** Record one hit against `key` under `rule`; returns the resulting outcome. */
  check(key: string, rule: RateLimitRule): RateLimitOutcome;
  /**
   * Record one hit against SEVERAL (key, rule) pairs at once — e.g. per-token AND
   * per-IP. Blocks if ANY limit is exceeded, returning the longest retry-after.
   */
  checkAll(entries: ReadonlyArray<{ key: string; rule: RateLimitRule }>): RateLimitOutcome;
  /** Test/maintenance helper — drop all counters. */
  reset(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const SWEEP_THRESHOLD = 10_000;

export function createRateLimiter(clock: Clock = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>();

  function check(key: string, rule: RateLimitRule): RateLimitOutcome {
    const now = clock();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      buckets.set(key, bucket);
      // Opportunistic sweep so the map cannot grow unbounded under many keys.
      if (buckets.size > SWEEP_THRESHOLD) {
        for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
      }
    }
    bucket.count += 1;
    const allowed = bucket.count <= rule.max;
    return {
      allowed,
      remaining: Math.max(0, rule.max - bucket.count),
      retryAfterMs: allowed ? 0 : bucket.resetAt - now,
    };
  }

  function checkAll(entries: ReadonlyArray<{ key: string; rule: RateLimitRule }>): RateLimitOutcome {
    // Increment every counter (so both per-token and per-IP advance), then decide.
    const results = entries.map((e) => check(e.key, e.rule));
    const blocked = results.filter((r) => !r.allowed);
    if (blocked.length === 0) {
      const remaining = results.length ? Math.min(...results.map((r) => r.remaining)) : Infinity;
      return { allowed: true, remaining, retryAfterMs: 0 };
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(...blocked.map((r) => r.retryAfterMs)),
    };
  }

  return {
    check,
    checkAll,
    reset() {
      buckets.clear();
    },
  };
}

/** Process-wide limiter shared by the public token routes. */
export const sharedRateLimiter: RateLimiter = createRateLimiter();

/**
 * Best-effort client IP from the standard proxy headers (Vercel sets
 * `x-forwarded-for`). Falls back to a constant so a missing header degrades to a
 * single shared bucket rather than throwing.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

/** Seconds value for a `Retry-After` header, rounded up, floored at 1. */
export function retryAfterSeconds(outcome: RateLimitOutcome): number {
  return Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
}
