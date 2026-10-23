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
  '/pay/(.*)',
  '/api/pay/(.*)',
  '/api/cron/(.*)',
  '/r/(.*)',
  '/api/r/(.*)',
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

  it('the tokenized invoice PDF is public', () => {
    expect(isPublic(`/api/pay/${TOKEN}/pdf`)).toBe(true);
  });

  it('Stripe webhooks are public', () => {
    expect(isPublic('/api/webhooks/stripe')).toBe(true);
  });

  it('sign-in and sign-up are public', () => {
    expect(isPublic('/sign-in')).toBe(true);
    expect(isPublic('/sign-up/verify')).toBe(true);
  });
});

describe('public routes — scheduler dispatcher', () => {
  // Vercel Cron has no Clerk session; the route's own Bearer CRON_SECRET check
  // (fail-closed, lib/scheduler/cron-auth.ts) is the credential.
  it('the cron tick is public at the middleware layer', () => {
    expect(isPublic('/api/cron/tick')).toBe(true);
  });

  it('the run-log read API is NOT public (Clerk + settings_system:view)', () => {
    expect(isPublic('/api/scheduler/runs')).toBe(false);
  });
});

describe('public routes — request magic links (migration 178)', () => {
  it('the /r/[token] link and its unsubscribe POST are public', () => {
    expect(isPublic('/r/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd')).toBe(true);
    expect(isPublic('/r/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/unsubscribe')).toBe(true);
    expect(isPublic('/api/r/unsubscribe')).toBe(true);
  });

  it.each(['/requests', '/reports', '/receipts', '/reconciliation', '/api/requests', '/api/requests/actions', '/api/reports/pl', '/api/notifications', '/r'])(
    '%s is NOT public',
    (path) => {
      expect(isPublic(path)).toBe(false);
    },
  );
});

describe('public routes — prefix collisions stay protected', () => {
  // '/pay(.*)' once matched '/payroll' and '/payments' — those are staff surfaces.
  it.each([
    '/payroll',
    '/payroll/runs',
    '/payments',
    '/api/payroll/runs',
    '/api/payments/release',
    '/api/payables',
    '/api/cronjobs',
  ])('%s is NOT public', (path) => {
    expect(isPublic(path)).toBe(false);
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

  it('does not expose invoice PDFs by raw id', () => {
    // The customer-facing PDF is served from the tokenized /api/pay/[token]/pdf
    // route instead. The id-addressed one stays protected: a raw invoice id is
    // not a credential, and widening the matcher to /api/invoices would expose
    // every invoice API alongside it.
    expect(isPublic('/api/invoices/abc-123/pdf')).toBe(false);
  });
});
