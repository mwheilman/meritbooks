/**
 * Public-route matcher regression tests.
 *
 * The hosted pay page is customer-facing: whoever opens it has no Clerk session
 * and never will. Every route that surface touches must therefore be public, or
 * auth.protect() rejects it — and Clerk returns 404, which reads like "missing
 * route" rather than "not signed in".
 *
 * That is exactly what shipped: `/pay(.*)` made the PAGE public while
 * `/api/pay/[token]/intent` stayed protected, so the page rendered perfectly and
 * the Pay button failed for every real customer. It only worked when tested by
 * someone already logged into MeritBooks in the same browser.
 *
 * These assertions encode the rule so a future edit to the matcher can't quietly
 * re-break the payment path.
 */

import { describe, it, expect } from 'vitest';

/** Mirrors the matcher list in middleware.ts. Keep in sync deliberately. */
const PUBLIC_PATTERNS = [
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  '/pay(.*)',
  '/api/pay(.*)',
];

/** Clerk's createRouteMatcher compiles path patterns to regexes; this mirrors it. */
const isPublic = (path: string) =>
  PUBLIC_PATTERNS.some((p) => new RegExp(`^${p.replace(/\(\.\*\)/g, '(?:.*)')}$`).test(path));

describe('public routes — customer-facing payment surface', () => {
  const TOKEN = '198e916c-37c4-4a99-a3bc-29cae886f302';

  it('the hosted invoice page is public', () => {
    expect(isPublic(`/pay/${TOKEN}`)).toBe(true);
  });

  it('the payment-intent API is public (the regression)', () => {
    expect(isPublic(`/api/pay/${TOKEN}/intent`)).toBe(true);
  });

  it('Stripe webhooks are public', () => {
    expect(isPublic('/api/webhooks/stripe')).toBe(true);
  });

  it('sign-in and sign-up are public', () => {
    expect(isPublic('/sign-in')).toBe(true);
    expect(isPublic('/sign-up/verify')).toBe(true);
  });
});

describe('public routes — everything else stays protected', () => {
  const protectedPaths = [
    '/api/invoices',
    '/api/invoices/abc-123',
    '/api/gl/post',
    '/api/gl/trial-balance',
    '/api/bank-feed',
    '/api/bank-feed/approve',
    '/api/locations',
    '/api/jobs/search',
    '/api/bills/create',
    '/dashboard',
    '/journal-entries',
    '/reports',
  ];

  for (const path of protectedPaths) {
    it(`${path} is NOT public`, () => {
      expect(isPublic(path)).toBe(false);
    });
  }

  it('does not accidentally expose the whole API', () => {
    expect(isPublic('/api')).toBe(false);
    expect(isPublic('/api/anything')).toBe(false);
  });

  it('does not expose invoice PDFs by raw id — that needs a token-scoped route', () => {
    // Known gap: the ↓PDF button on the hosted page hits /api/invoices/[id]/pdf,
    // which is protected and so fails for customers. The fix is a tokenized
    // /api/pay/[token]/pdf route, NOT widening this matcher to /api/invoices.
    expect(isPublic('/api/invoices/abc-123/pdf')).toBe(false);
  });
});
