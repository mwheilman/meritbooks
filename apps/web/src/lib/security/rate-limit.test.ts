/**
 * Rate limiter unit tests — pins the abuse-throttle behaviour the public token
 * routes (vendor upload, customer statement, hosted-pay intent) depend on:
 *   - allows exactly `max` requests in a window, blocks the next,
 *   - the window resets after `windowMs` (injected clock, no real timers),
 *   - keys are isolated (one token/IP hitting its cap never blocks another),
 *   - checkAll blocks if EITHER the per-token OR per-IP limit is exceeded.
 */

import { describe, it, expect } from 'vitest';
import { createRateLimiter } from './rate-limit';

describe('createRateLimiter', () => {
  it('allows up to max requests, then blocks (429 path)', () => {
    let now = 1_000;
    const limiter = createRateLimiter(() => now);
    const rule = { windowMs: 60_000, max: 3 };

    expect(limiter.check('k', rule).allowed).toBe(true); // 1
    expect(limiter.check('k', rule).allowed).toBe(true); // 2
    const third = limiter.check('k', rule); // 3 (last allowed)
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = limiter.check('k', rule); // 4 → blocked
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterMs).toBe(60_000);
  });

  it('resets after the window elapses', () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    const rule = { windowMs: 1_000, max: 1 };

    expect(limiter.check('k', rule).allowed).toBe(true);
    expect(limiter.check('k', rule).allowed).toBe(false); // blocked in window

    now += 1_000; // window boundary
    expect(limiter.check('k', rule).allowed).toBe(true); // fresh window
  });

  it('isolates keys — one key at its cap does not block another', () => {
    const now = 5;
    const limiter = createRateLimiter(() => now);
    const rule = { windowMs: 60_000, max: 1 };

    expect(limiter.check('token:a', rule).allowed).toBe(true);
    expect(limiter.check('token:a', rule).allowed).toBe(false); // a is capped
    expect(limiter.check('token:b', rule).allowed).toBe(true); // b unaffected
  });

  it('checkAll blocks when EITHER the per-token or per-IP limit is exceeded', () => {
    const now = 0;
    const limiter = createRateLimiter(() => now);
    const perToken = { windowMs: 60_000, max: 5 };
    const perIp = { windowMs: 60_000, max: 2 };
    const entries = [
      { key: 'token:t1', rule: perToken },
      { key: 'ip:1.2.3.4', rule: perIp },
    ];

    expect(limiter.checkAll(entries).allowed).toBe(true); // 1
    expect(limiter.checkAll(entries).allowed).toBe(true); // 2 (IP now at cap)
    const blocked = limiter.checkAll(entries); // 3 → IP exceeded even though token is fine
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(60_000);
  });
});
